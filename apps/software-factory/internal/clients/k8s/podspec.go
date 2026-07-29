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

// maxPodNameLength is Kubernetes' DNS-1123 label limit, which a pod name is.
const maxPodNameLength = 63

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

	cpu, err := resource.ParseQuantity(spec.CPULimit)
	if err != nil {
		return nil, fmt.Errorf("building the sandbox pod for ticket %d: cpu limit %q: %w: %w", spec.TicketNumber, spec.CPULimit, err, work.ErrPermanent)
	}
	memory, err := resource.ParseQuantity(spec.MemoryLimit)
	if err != nil {
		return nil, fmt.Errorf("building the sandbox pod for ticket %d: memory limit %q: %w: %w", spec.TicketNumber, spec.MemoryLimit, err, work.ErrPermanent)
	}

	// Requests equal limits, so the pod is Guaranteed QoS and a noisy
	// neighbour cannot evict a ticket mid-run.
	resources := corev1.ResourceRequirements{
		Requests: corev1.ResourceList{corev1.ResourceCPU: cpu, corev1.ResourceMemory: memory},
		Limits:   corev1.ResourceList{corev1.ResourceCPU: cpu, corev1.ResourceMemory: memory},
	}

	workSize := resource.NewQuantity(workSizeLimitBytes, resource.BinarySI)
	uid := sandboxUID

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
			Containers: []corev1.Container{{
				Name:            o.containerName,
				Image:           spec.Image,
				ImagePullPolicy: corev1.PullIfNotPresent,
				// A session staged into, not a job: the stages are execs. Argv
				// only — no shell here and none in the image's entrypoint.
				Command:      []string{"sleep", "infinity"},
				Env:          sortedEnv(spec.Env),
				Resources:    resources,
				VolumeMounts: []corev1.VolumeMount{{Name: workVolumeName, MountPath: work.SandboxRoot}},
				SecurityContext: &corev1.SecurityContext{
					RunAsNonRoot:             ptr(true),
					RunAsUser:                &uid,
					RunAsGroup:               &uid,
					AllowPrivilegeEscalation: ptr(false),
					Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
					SeccompProfile:           &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
				},
			}},
			Volumes: []corev1.Volume{{
				Name:         workVolumeName,
				VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: workSize}},
			}},
		},
	}, nil
}

// workVolumeName is the emptyDir mounted at work.SandboxRoot.
const workVolumeName = "work"

// sortedEnv renders an environment map in key order. Map iteration is random,
// so an unsorted slice would make two builds of one spec differ and defeat both
// specMatches and any test that compares pods.
func sortedEnv(env map[string]string) []corev1.EnvVar {
	if len(env) == 0 {
		return nil
	}
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	out := make([]corev1.EnvVar, 0, len(keys))
	for _, k := range keys {
		out = append(out, corev1.EnvVar{Name: k, Value: env[k]})
	}
	return out
}

// ptr returns a pointer to v, for the many optional pod-spec fields whose
// unset and false meanings differ.
func ptr[T any](v T) *T { return &v }
