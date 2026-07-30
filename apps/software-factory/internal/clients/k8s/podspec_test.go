package k8s

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// validSpec is the spec every pod-building test starts from, so each case
// changes exactly the one field it is about.
func validSpec() work.SandboxSpec {
	return work.SandboxSpec{
		TicketNumber:    42,
		RunID:           "3f1c2a7e-0000-4000-8000-000000000001",
		Image:           "ghcr.io/0x63616c/sandbox@sha256:" + strings.Repeat("a", 64),
		CPULimit:        "2",
		MemoryLimit:     "4Gi",
		DeadlineSeconds: 3600,
		Env:             map[string]string{"CODEX_HOME": "/work/.codex"},
	}
}

func mustBuild(t *testing.T, spec work.SandboxSpec) *corev1.Pod {
	t.Helper()
	pod, err := buildPod(spec, defaultOptions())
	if err != nil {
		t.Fatalf("buildPod returned an unexpected error: %v", err)
	}
	return pod
}

func sandboxContainer(t *testing.T, pod *corev1.Pod) corev1.Container {
	t.Helper()
	if len(pod.Spec.Containers) != 1 {
		t.Fatalf("pod has %d containers, want exactly 1", len(pod.Spec.Containers))
	}
	return pod.Spec.Containers[0]
}

func TestBuildPodNamesThePodForItsTicketNumberAndRun(t *testing.T) {
	t.Parallel()

	pod := mustBuild(t, validSpec())
	want := "sandbox-ticket-42-3f1c2a7e-0000-4000-8000-000000000001"
	if pod.Name != want {
		t.Errorf("pod name = %q, want %q", pod.Name, want)
	}
}

func TestBuildPodRejectsANameThatWouldExceedTheKubernetesLimit(t *testing.T) {
	t.Parallel()

	spec := validSpec()
	spec.RunID = strings.Repeat("a", 64)

	pod, err := buildPod(spec, defaultOptions())
	if !errors.Is(err, work.ErrPermanent) {
		t.Fatalf("buildPod error = %v, want it to wrap work.ErrPermanent", err)
	}
	if pod != nil {
		t.Errorf("buildPod returned a pod named %q; a name over the limit must never be truncated into one", pod.Name)
	}
}

// TestBuildPodRunsTheEmbeddedWorkerAsTheContainerCommandWithNoShell is
// TestBuildPodRunsSleepInfinityAsTheContainerCommandWithNoShell's #434
// replacement: the pod's own embedded Temporal worker (cmd/sandbox-worker,
// installed by images/sandbox/Dockerfile) is what runs now, not `sleep
// infinity` with stages arriving over pods/exec — but the argv-only
// guarantee this test polices is unchanged either way.
func TestBuildPodRunsTheEmbeddedWorkerAsTheContainerCommandWithNoShell(t *testing.T) {
	t.Parallel()

	c := sandboxContainer(t, mustBuild(t, validSpec()))
	if want := []string{sandboxWorkerBinaryPath}; !reflect.DeepEqual(c.Command, want) {
		t.Errorf("container command = %v, want %v", c.Command, want)
	}
	if len(c.Args) != 0 {
		t.Errorf("container args = %v, want none", c.Args)
	}
	for _, arg := range c.Command {
		if arg == "sh" || arg == "bash" || arg == "-c" {
			t.Errorf("container command contains %q; the sandbox is entered by argv, never through a shell", arg)
		}
	}
}

func TestBuildPodNeverMountsAServiceAccountToken(t *testing.T) {
	t.Parallel()

	pod := mustBuild(t, validSpec())
	if pod.Spec.AutomountServiceAccountToken == nil || *pod.Spec.AutomountServiceAccountToken {
		t.Errorf("automountServiceAccountToken = %v, want an explicit false", pod.Spec.AutomountServiceAccountToken)
	}
	if pod.Spec.ServiceAccountName != "" {
		t.Errorf("serviceAccountName = %q, want it unset so the pod lands on the bindingless default", pod.Spec.ServiceAccountName)
	}
}

func TestBuildPodDoesNotInjectServiceEnvironmentVariables(t *testing.T) {
	t.Parallel()

	pod := mustBuild(t, validSpec())
	if pod.Spec.EnableServiceLinks == nil || *pod.Spec.EnableServiceLinks {
		t.Errorf("enableServiceLinks = %v, want an explicit false", pod.Spec.EnableServiceLinks)
	}
}

func TestBuildPodNeverRestartsTheSandboxContainer(t *testing.T) {
	t.Parallel()

	if got := mustBuild(t, validSpec()).Spec.RestartPolicy; got != corev1.RestartPolicyNever {
		t.Errorf("restartPolicy = %q, want %q", got, corev1.RestartPolicyNever)
	}
}

func TestBuildPodCarriesTheSpecsActiveDeadline(t *testing.T) {
	t.Parallel()

	pod := mustBuild(t, validSpec())
	if pod.Spec.ActiveDeadlineSeconds == nil || *pod.Spec.ActiveDeadlineSeconds != 3600 {
		t.Errorf("activeDeadlineSeconds = %v, want 3600", pod.Spec.ActiveDeadlineSeconds)
	}
}

func TestBuildPodTerminatesWithoutAGracePeriod(t *testing.T) {
	t.Parallel()

	pod := mustBuild(t, validSpec())
	if pod.Spec.TerminationGracePeriodSeconds == nil || *pod.Spec.TerminationGracePeriodSeconds != 0 {
		t.Errorf("terminationGracePeriodSeconds = %v, want 0 to match Delete's grace", pod.Spec.TerminationGracePeriodSeconds)
	}
}

func TestBuildPodRequestsExactlyWhatItLimits(t *testing.T) {
	t.Parallel()

	c := sandboxContainer(t, mustBuild(t, validSpec()))
	for _, name := range []corev1.ResourceName{corev1.ResourceCPU, corev1.ResourceMemory} {
		req, lim := c.Resources.Requests[name], c.Resources.Limits[name]
		if req.Cmp(lim) != 0 {
			t.Errorf("%s request %s != limit %s; a sandbox must be Guaranteed QoS", name, req.String(), lim.String())
		}
	}
	cpu, memory := c.Resources.Limits[corev1.ResourceCPU], c.Resources.Limits[corev1.ResourceMemory]
	if want := resource.MustParse("2"); cpu.Cmp(want) != 0 {
		t.Errorf("cpu limit = %s, want 2", cpu.String())
	}
	if want := resource.MustParse("4Gi"); memory.Cmp(want) != 0 {
		t.Errorf("memory limit = %s, want 4Gi", memory.String())
	}
}

func TestBuildPodRejectsAMalformedCPUQuantity(t *testing.T) {
	t.Parallel()

	spec := validSpec()
	spec.CPULimit = "2x"
	if _, err := buildPod(spec, defaultOptions()); !errors.Is(err, work.ErrPermanent) {
		t.Errorf("buildPod error = %v, want it to wrap work.ErrPermanent", err)
	}
}

func TestBuildPodDropsAllCapabilitiesAndForbidsPrivilegeEscalation(t *testing.T) {
	t.Parallel()

	sc := sandboxContainer(t, mustBuild(t, validSpec())).SecurityContext
	if sc == nil {
		t.Fatal("container has no securityContext")
	}
	if sc.AllowPrivilegeEscalation == nil || *sc.AllowPrivilegeEscalation {
		t.Errorf("allowPrivilegeEscalation = %v, want an explicit false", sc.AllowPrivilegeEscalation)
	}
	if sc.Capabilities == nil || !reflect.DeepEqual(sc.Capabilities.Drop, []corev1.Capability{"ALL"}) {
		t.Errorf("capabilities = %+v, want all dropped", sc.Capabilities)
	}
	if sc.Privileged != nil && *sc.Privileged {
		t.Error("container is privileged; the sandbox needs hardening, not privilege")
	}
}

func TestBuildPodRunsAsANonRootUserUnderTheDefaultSeccompProfile(t *testing.T) {
	t.Parallel()

	pod := mustBuild(t, validSpec())
	sc := sandboxContainer(t, pod).SecurityContext
	if sc == nil || sc.RunAsNonRoot == nil || !*sc.RunAsNonRoot {
		t.Fatalf("runAsNonRoot = %+v, want an explicit true", sc)
	}
	if sc.RunAsUser == nil || *sc.RunAsUser == 0 {
		t.Errorf("runAsUser = %v, want a non-zero uid", sc.RunAsUser)
	}
	if sc.RunAsGroup == nil || *sc.RunAsGroup == 0 {
		t.Errorf("runAsGroup = %v, want a non-zero gid", sc.RunAsGroup)
	}
	if sc.SeccompProfile == nil || sc.SeccompProfile.Type != corev1.SeccompProfileTypeRuntimeDefault {
		t.Errorf("seccompProfile = %+v, want RuntimeDefault", sc.SeccompProfile)
	}
	// The /work emptyDir must be writable by the uid the container runs as, or
	// Read's ownership invariant (which is what makes `test -e` exit 1 mean
	// "absent" rather than "unreadable") does not hold.
	if pod.Spec.SecurityContext == nil || pod.Spec.SecurityContext.FSGroup == nil ||
		*pod.Spec.SecurityContext.FSGroup != *sc.RunAsGroup {
		t.Errorf("pod fsGroup = %+v, want it equal to the container's runAsGroup so /work is owned by it", pod.Spec.SecurityContext)
	}
}

func TestBuildPodAcceptsTheKnownSandboxEnvKeys(t *testing.T) {
	t.Parallel()

	spec := validSpec()
	spec.Env = map[string]string{
		work.CodexHomeEnv:                "/work/.codex",
		work.GhConfigDirEnv:              "/work/.config/gh",
		work.SandboxBranchEnv:            "sf/ticket-42",
		work.SandboxTaskQueueEnv:         "software-factory-sandbox-run-1",
		work.SandboxTemporalHostPortEnv:  "temporal-frontend.temporal:7233",
		work.SandboxTemporalNamespaceEnv: "software-factory",
	}
	if _, err := buildPod(spec, defaultOptions()); err != nil {
		t.Fatalf("buildPod returned an unexpected error for the known env keys: %v", err)
	}
}

func TestBuildPodRejectsAnUnknownSandboxEnvKey(t *testing.T) {
	t.Parallel()

	spec := validSpec()
	spec.Env = map[string]string{
		work.CodexHomeEnv:       "/work/.codex",
		"AWS_SECRET_ACCESS_KEY": "leaked",
	}
	_, err := buildPod(spec, defaultOptions())
	if !errors.Is(err, work.ErrPermanent) {
		t.Fatalf("buildPod error = %v, want it to wrap work.ErrPermanent", err)
	}
	if !strings.Contains(err.Error(), "AWS_SECRET_ACCESS_KEY") {
		t.Errorf("buildPod error = %q, want it to name the offending key", err.Error())
	}
}

func TestBuildPodSetsImagePullSecretsFromOptions(t *testing.T) {
	t.Parallel()

	o := defaultOptions()
	o.imagePullSecretName = "ghcr-pull"

	pod, err := buildPod(validSpec(), o)
	if err != nil {
		t.Fatalf("buildPod returned an unexpected error: %v", err)
	}
	want := []corev1.LocalObjectReference{{Name: "ghcr-pull"}}
	if !reflect.DeepEqual(pod.Spec.ImagePullSecrets, want) {
		t.Errorf("imagePullSecrets = %+v, want %+v; the sandbox image is private on GHCR and an anonymous pull 401s", pod.Spec.ImagePullSecrets, want)
	}
}

func TestBuildPodLeavesImagePullSecretsUnsetWhenOptionsCarryNone(t *testing.T) {
	t.Parallel()

	pod := mustBuild(t, validSpec())
	if len(pod.Spec.ImagePullSecrets) != 0 {
		t.Errorf("imagePullSecrets = %+v, want none when no secret name was configured", pod.Spec.ImagePullSecrets)
	}
}

func TestBuildPodLabelsThePodSoASweepCanFindItByTicketAndRun(t *testing.T) {
	t.Parallel()

	got := mustBuild(t, validSpec()).Labels
	want := map[string]string{
		"app.kubernetes.io/name":                   "software-factory-sandbox",
		"app.kubernetes.io/managed-by":             "software-factory",
		"software-factory.worldwidewebb.co/ticket": "42",
		"software-factory.worldwidewebb.co/run-id": "3f1c2a7e-0000-4000-8000-000000000001",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("labels = %v, want %v", got, want)
	}
}

func TestBuildPodOrdersEnvironmentVariablesDeterministically(t *testing.T) {
	t.Parallel()

	// Through buildPod, with the three real allowlisted keys, deliberately
	// written out of order — this is the coverage the allowlist must not
	// erode. buildPod's allowlist loop only validates spec.Env today, never
	// filters or reorders it before sortedEnv renders it (podspec.go:157),
	// but a later change that made the loop filter rather than merely
	// validate could silently reorder or drop env, and that's exactly the
	// case a helper-level test of sortedEnv alone would stop catching.
	spec := validSpec()
	spec.Env = map[string]string{
		work.SandboxBranchEnv: "sf/ticket-42",
		work.CodexHomeEnv:     "/work/.codex",
		work.GhConfigDirEnv:   "/work/.config/gh",
	}

	first := sandboxContainer(t, mustBuild(t, spec)).Env
	second := sandboxContainer(t, mustBuild(t, spec)).Env
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("two builds of one spec produced different env: %v vs %v", first, second)
	}
	for i := 1; i < len(first); i++ {
		if first[i-1].Name >= first[i].Name {
			t.Fatalf("env is not sorted by key: %v", first)
		}
	}
}

func TestSortedEnvOrdersAnArbitraryMapByKey(t *testing.T) {
	t.Parallel()

	// sortedEnv in isolation, with more keys than the allowlist admits, so
	// the sort itself is exercised independently of which keys buildPod lets
	// through.
	env := map[string]string{"E": "5", "A": "1", "D": "4", "B": "2", "C": "3"}

	first := sortedEnv(env)
	second := sortedEnv(env)
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("two renders of one map produced different env: %v vs %v", first, second)
	}
	for i := 1; i < len(first); i++ {
		if first[i-1].Name >= first[i].Name {
			t.Fatalf("env is not sorted by key: %v", first)
		}
	}
}

func TestBuildPodMountsAWritableEmptyDirAtTheSandboxRoot(t *testing.T) {
	t.Parallel()

	pod := mustBuild(t, validSpec())
	if len(pod.Spec.Volumes) != 2 {
		t.Fatalf("pod has %d volumes, want exactly 2 (the emptyDir and the credential secret)", len(pod.Spec.Volumes))
	}
	vol := pod.Spec.Volumes[0]
	if vol.EmptyDir == nil {
		t.Fatalf("volume %q is not an emptyDir; a sandbox is disposable and the branch is pushed to origin", vol.Name)
	}
	if vol.EmptyDir.SizeLimit == nil {
		t.Error("emptyDir has no sizeLimit; an unbounded one consumes the node's ephemeral storage")
	}

	c := sandboxContainer(t, pod)
	if len(c.VolumeMounts) != 2 {
		t.Fatalf("volume mounts = %+v, want exactly 2 (the sandbox root and the credential mount)", c.VolumeMounts)
	}
	if c.VolumeMounts[0].MountPath != work.SandboxRoot {
		t.Errorf("volume mounts = %+v, want the first one at %q", c.VolumeMounts, work.SandboxRoot)
	}
	if c.VolumeMounts[0].ReadOnly {
		t.Error("the sandbox root is mounted read-only; stages write into it")
	}
}

// TestBuildPodMountsTheCodexCredentialSecretDirectlyAtCodexAuthFile proves D3
// (#434): the per-ticket credential Secret is mounted, via subPath, at exactly
// the path the codex CLI reads — so Kubernetes itself puts the credential in
// place at container start, and no activity ever writes it.
func TestBuildPodMountsTheCodexCredentialSecretDirectlyAtCodexAuthFile(t *testing.T) {
	t.Parallel()

	spec := validSpec()
	pod := mustBuild(t, spec)
	sandbox := work.SandboxID("sandbox-ticket-42-3f1c2a7e-0000-4000-8000-000000000001")

	var vol *corev1.Volume
	for i := range pod.Spec.Volumes {
		if pod.Spec.Volumes[i].Name == credentialSecretVolumeName {
			vol = &pod.Spec.Volumes[i]
		}
	}
	if vol == nil {
		t.Fatalf("no volume named %q; pod volumes = %+v", credentialSecretVolumeName, pod.Spec.Volumes)
	}
	if vol.Secret == nil {
		t.Fatalf("volume %q is not a secret volume", vol.Name)
	}
	if want := credentialSecretName(sandbox); vol.Secret.SecretName != want {
		t.Errorf("secret name = %q, want %q — Create and Delete must name the same object", vol.Secret.SecretName, want)
	}
	if vol.Secret.DefaultMode == nil || *vol.Secret.DefaultMode != 0o440 {
		t.Errorf("defaultMode = %v, want 0440: owner-read alone leaves root as the only reader", vol.Secret.DefaultMode)
	}

	c := sandboxContainer(t, pod)
	var mount *corev1.VolumeMount
	for i := range c.VolumeMounts {
		if c.VolumeMounts[i].Name == credentialSecretVolumeName {
			mount = &c.VolumeMounts[i]
		}
	}
	if mount == nil {
		t.Fatalf("no volume mount named %q; mounts = %+v", credentialSecretVolumeName, c.VolumeMounts)
	}
	if mount.MountPath != work.CodexAuthFile {
		t.Errorf("mount path = %q, want %q", mount.MountPath, work.CodexAuthFile)
	}
	if mount.SubPath != codexAuthSecretKey {
		t.Errorf("subPath = %q, want %q", mount.SubPath, codexAuthSecretKey)
	}
	if !mount.ReadOnly {
		t.Error("the credential mount is writable; nothing inside the sandbox should be able to alter its own credential")
	}
}

func TestBuildPodRejectsASpecItCannotNameAPodFor(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		mutate func(*work.SandboxSpec)
	}{
		{"a ticket number that is not positive", func(s *work.SandboxSpec) { s.TicketNumber = 0 }},
		{"a negative ticket number", func(s *work.SandboxSpec) { s.TicketNumber = -1 }},
		{"an empty image", func(s *work.SandboxSpec) { s.Image = "" }},
		{"an empty run id", func(s *work.SandboxSpec) { s.RunID = "" }},
		{"a run id that is not a valid name", func(s *work.SandboxSpec) { s.RunID = "Not/A Name" }},
		{"a deadline that is not positive", func(s *work.SandboxSpec) { s.DeadlineSeconds = 0 }},
		{"a malformed memory quantity", func(s *work.SandboxSpec) { s.MemoryLimit = "4Gigs" }},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			spec := validSpec()
			tc.mutate(&spec)
			if _, err := buildPod(spec, defaultOptions()); !errors.Is(err, work.ErrPermanent) {
				t.Errorf("buildPod error = %v, want it to wrap work.ErrPermanent", err)
			}
		})
	}
}
