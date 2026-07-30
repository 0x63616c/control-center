package k8s

import (
	"fmt"
	"sort"
	"strconv"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// Label keys on every sandbox pod. They exist so a sweep can find and attribute
// a pod by selector, without parsing its name.
const (
	labelName      = "app.kubernetes.io/name"
	labelManagedBy = "app.kubernetes.io/managed-by"
	labelTicket    = "software-factory.worldwidewebb.co/ticket"
	labelRunID     = "software-factory.worldwidewebb.co/run-id"

	labelNameValue      = "software-factory-sandbox"
	labelManagedByValue = "software-factory"
)

// sandboxUID is the uid and gid the sandbox image runs as, and the owner of the
// /work emptyDir. It is a contract with that image: Read's ownership invariant
// — that `test -e` exiting 1 means absent rather than unreadable — holds only
// while every path under the sandbox root is owned by the one uid writing it.
const sandboxUID int64 = 1000

// workSizeLimitBytes bounds the /work emptyDir. Unbounded, a runaway clone or
// build consumes the node's ephemeral storage and evicts its neighbours; this
// cluster is a single node, so those neighbours are the rest of the house.
const workSizeLimitBytes = 20 << 30

// sandboxWorkerBinaryPath is where images/sandbox/Dockerfile installs
// cmd/sandbox-worker — a contract with that image, the same shape as
// sandboxUID above.
const sandboxWorkerBinaryPath = "/usr/local/bin/sandbox-worker"

// allowedSandboxEnvKeys is the deny-by-default allowlist for spec.Env. A
// container in this cluster inherits nothing from the node or kubelet — this
// map IS the sandbox's entire environment contract (image-baked ENV
// directives aside), so a key that reaches buildPod outside this set is
// treated as a configuration bug, not silently passed through. Set from
// cmd/worker/main.go's static SandboxTemplate.Env (work.CodexHomeEnv,
// work.GhConfigDirEnv, and — new for #434 step 3 — the two Temporal env vars
// the pod's own embedded worker dials with) and from work.SandboxTemplate.Spec
// per ticket (work.SandboxBranchEnv, work.SandboxTaskQueueEnv).
var allowedSandboxEnvKeys = map[string]bool{
	work.CodexHomeEnv:                true,
	work.GhConfigDirEnv:              true,
	work.SandboxBranchEnv:            true,
	work.SandboxTaskQueueEnv:         true,
	work.SandboxTemporalHostPortEnv:  true,
	work.SandboxTemporalNamespaceEnv: true,
}

// maxPodNameLength is Kubernetes' DNS-1123 label limit, which a pod name is.
const maxPodNameLength = 63

// credentialSecretPrefix opens every per-ticket credential Secret's name, the
// same "shared prefix over the sandbox's own SandboxID" pattern
// sandboxTaskQueuePrefix uses in internal/work/queue.go — visually distinct in
// `kubectl get secrets`, and a guarantee against a second spelling appearing
// anywhere else.
const credentialSecretPrefix = "codex-credential-"

// credentialSecretVolumeName names the volume that mounts a sandbox's
// per-ticket credential Secret.
const credentialSecretVolumeName = "codex-credential"

// codexAuthSecretKey is the one key inside a sandbox's credential Secret: the
// whole of the codex CLI's auth.json document.
const codexAuthSecretKey = "auth.json"

// credentialSecretDefaultMode is the file mode Kubernetes applies to the
// mounted key.
//
// Group-read, not owner-read alone: a Secret volume's files are always owned
// by root and the pod's fsGroup (never the container's own uid), regardless
// of the container's RunAsUser — see buildPod's SecurityContext, which sets
// both FSGroup and the container's RunAsGroup to sandboxUID. Owner-only
// (0400) would leave root holding the only readable bit and the sandbox
// process unable to open its own credential.
var credentialSecretDefaultMode int32 = 0o440

// credentialSecretName returns the per-ticket Secret name a sandbox pod
// mounts its codex credential from, derived from the pod's own name rather
// than minted separately.
//
// One function, called from buildPod (to name the volume it wires in) and
// from lifecycle.go's ensureCredentialSecret/deleteCredentialSecret (to name
// the object it writes and later removes) — so all three can never disagree
// about which Secret a given sandbox means. The pod name already carries the
// run id and is already validated as DNS-1123-label-safe by podName above, so
// prefixing it stays well inside a Secret name's looser DNS-1123-subdomain
// limit (253 characters) without any further validation here.
func credentialSecretName(sandbox work.SandboxID) string {
	return credentialSecretPrefix + string(sandbox)
}

// podName is the one spelling of a sandbox's Kubernetes name.
//
// It carries the run id as well as the ticket, so an AlreadyExists on Create can
// only mean this run's own Create is being retried — never that an older run
// left a pod behind with a different spec and a deadline already ticking.
func podName(spec work.SandboxSpec) (string, error) {
	if spec.TicketNumber <= 0 {
		return "", fmt.Errorf("naming a sandbox for ticket %d: ticket numbers are positive: %w", spec.TicketNumber, work.ErrPermanent)
	}
	if spec.RunID == "" {
		return "", fmt.Errorf("naming a sandbox for ticket %d: the run id is empty: %w", spec.TicketNumber, work.ErrPermanent)
	}

	name := fmt.Sprintf("sandbox-ticket-%d-%s", spec.TicketNumber, spec.RunID)
	if len(name) > maxPodNameLength {
		// Truncating would reintroduce the collisions the run id is here to
		// remove, so this fails instead.
		return "", fmt.Errorf("naming a sandbox for ticket %d: %q is %d characters, over the %d-character limit: %w",
			spec.TicketNumber, name, len(name), maxPodNameLength, work.ErrPermanent)
	}
	if problems := validation.IsDNS1123Label(name); len(problems) > 0 {
		return "", fmt.Errorf("naming a sandbox for ticket %d: %q is not a valid pod name: %s: %w",
			spec.TicketNumber, name, problems[0], work.ErrPermanent)
	}
	return name, nil
}

// buildPod turns a SandboxSpec into the pod that runs it. It is pure, so every
// field below is asserted by a unit test rather than by a cluster.
//
// A spec it cannot build is a permanent error: a malformed quantity or an empty
// image is a configuration bug, and no number of retries fixes one.
func buildPod(spec work.SandboxSpec, o options) (*corev1.Pod, error) {
	name, err := podName(spec)
	if err != nil {
		return nil, err
	}
	if spec.Image == "" {
		return nil, fmt.Errorf("building the sandbox pod for ticket %d: the image is empty: %w", spec.TicketNumber, work.ErrPermanent)
	}
	if spec.DeadlineSeconds <= 0 {
		return nil, fmt.Errorf("building the sandbox pod for ticket %d: the deadline is %ds, which Kubernetes will not accept: %w",
			spec.TicketNumber, spec.DeadlineSeconds, work.ErrPermanent)
	}
	for _, key := range sortedKeys(spec.Env) {
		if !allowedSandboxEnvKeys[key] {
			return nil, fmt.Errorf("building the sandbox pod for ticket %d: env var %q is not on the sandbox allowlist: %w",
				spec.TicketNumber, key, work.ErrPermanent)
		}
	}

	cpu, err := resource.ParseQuantity(spec.CPURequest)
	if err != nil {
		return nil, fmt.Errorf("building the sandbox pod for ticket %d: cpu request %q: %w: %w", spec.TicketNumber, spec.CPURequest, err, work.ErrPermanent)
	}
	memory, err := resource.ParseQuantity(spec.MemoryLimit)
	if err != nil {
		return nil, fmt.Errorf("building the sandbox pod for ticket %d: memory limit %q: %w: %w", spec.TicketNumber, spec.MemoryLimit, err, work.ErrPermanent)
	}

	// CPU is requested but not limited: CPU is compressible and #87 banned
	// limiting it repo-wide. Memory keeps both a request and a limit, since
	// memory is incompressible and an unlimited sandbox could exhaust the node.
	//
	// This deliberately makes the sandbox pod Burstable rather than Guaranteed
	// QoS: Guaranteed requires limits to equal requests for every resource, and
	// dropping the CPU limit alone breaks that. Burstable pods are evicted
	// before Guaranteed ones under node memory pressure, which matters here
	// because up to two 8Gi sandboxes (max_in_flight: 2) can be resident on
	// this single node at once. That is the accepted consequence of #87's
	// repo-wide ban, not an oversight — every other Burstable workload in this
	// repo carries the same trade.
	resources := corev1.ResourceRequirements{
		Requests: corev1.ResourceList{corev1.ResourceCPU: cpu, corev1.ResourceMemory: memory},
		Limits:   corev1.ResourceList{corev1.ResourceMemory: memory},
	}

	workSize := resource.NewQuantity(workSizeLimitBytes, resource.BinarySI)
	uid := sandboxUID

	var imagePullSecrets []corev1.LocalObjectReference
	if o.imagePullSecretName != "" {
		// Explicit, not a namespace-default fallback: see WithImagePullSecret.
		imagePullSecrets = []corev1.LocalObjectReference{{Name: o.imagePullSecretName}}
	}

	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: name,
			Labels: map[string]string{
				labelName:      labelNameValue,
				labelManagedBy: labelManagedByValue,
				labelTicket:    strconv.Itoa(spec.TicketNumber),
				labelRunID:     spec.RunID,
			},
		},
		Spec: corev1.PodSpec{
			RestartPolicy:                 corev1.RestartPolicyNever,
			ActiveDeadlineSeconds:         ptr(spec.DeadlineSeconds),
			AutomountServiceAccountToken:  ptr(false),
			EnableServiceLinks:            ptr(false),
			TerminationGracePeriodSeconds: ptr(int64(0)),
			SecurityContext:               &corev1.PodSecurityContext{FSGroup: &uid},
			ImagePullSecrets:              imagePullSecrets,
			Containers: []corev1.Container{{
				Name:            o.containerName,
				Image:           spec.Image,
				ImagePullPolicy: corev1.PullIfNotPresent,
				// The pod's own embedded Temporal worker (#434 step 3,
				// cmd/sandbox-worker) — not `sleep infinity` with stages
				// arriving over pods/exec, which is what this line built
				// before Sessions replaced that transport. Argv only, still:
				// no shell here and none in the image's entrypoint, and this
				// binary takes no arguments — its whole configuration is the
				// env vars set below (work.SandboxTemporalHostPortEnv,
				// work.SandboxTemporalNamespaceEnv, work.SandboxTaskQueueEnv).
				Command:   []string{sandboxWorkerBinaryPath},
				Env:       sortedEnv(spec.Env),
				Resources: resources,
				VolumeMounts: []corev1.VolumeMount{
					{Name: workVolumeName, MountPath: work.SandboxRoot},
					// Deliberately NOT nested under work.SandboxRoot, let alone
					// under work.CodexHomeDir — see work.CodexAuthSecretMountFile's
					// own doc comment for why: a subPath mount at the codex CLI's
					// own auth.json path made Kubernetes, not the sandbox uid, own
					// the directory codex also needed to write other files into,
					// and every one of those writes 403'd in prod run one (#434).
					// cmd/sandbox-worker symlinks work.CodexAuthFile to this path
					// at startup; CreateSandbox still provisions the Secret and
					// nothing ever writes the credential's own bytes.
					{
						Name:      credentialSecretVolumeName,
						MountPath: work.CodexAuthSecretMountFile,
						SubPath:   codexAuthSecretKey,
						ReadOnly:  true,
					},
				},
				SecurityContext: &corev1.SecurityContext{
					RunAsNonRoot:             ptr(true),
					RunAsUser:                &uid,
					RunAsGroup:               &uid,
					AllowPrivilegeEscalation: ptr(false),
					Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
					SeccompProfile:           &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
				},
			}},
			Volumes: []corev1.Volume{
				{
					Name:         workVolumeName,
					VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: workSize}},
				},
				{
					Name: credentialSecretVolumeName,
					VolumeSource: corev1.VolumeSource{
						Secret: &corev1.SecretVolumeSource{
							SecretName:  credentialSecretName(work.SandboxID(name)),
							DefaultMode: &credentialSecretDefaultMode,
							Items:       []corev1.KeyToPath{{Key: codexAuthSecretKey, Path: codexAuthSecretKey}},
						},
					},
				},
			},
		},
	}, nil
}

// workVolumeName is the emptyDir mounted at work.SandboxRoot.
const workVolumeName = "work"

// sortedKeys returns env's keys in sorted order. Map iteration is random, so
// callers that need a deterministic pass over env — sortedEnv below, and the
// allowlist check in buildPod — share this rather than each sorting their own
// copy out of step with the other.
func sortedKeys(env map[string]string) []string {
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// sortedEnv renders an environment map in key order. Map iteration is random,
// so an unsorted slice would make two builds of one spec differ and defeat both
// specMatches and any test that compares pods.
func sortedEnv(env map[string]string) []corev1.EnvVar {
	if len(env) == 0 {
		return nil
	}
	keys := sortedKeys(env)
	out := make([]corev1.EnvVar, 0, len(keys))
	for _, k := range keys {
		out = append(out, corev1.EnvVar{Name: k, Value: env[k]})
	}
	return out
}

// ptr returns a pointer to v, for the many optional pod-spec fields whose
// unset and false meanings differ.
func ptr[T any](v T) *T { return &v }
