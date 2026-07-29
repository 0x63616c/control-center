package k8s

import "time"

// options is the tunable part of a Sandboxes. Everything here has a default
// that is correct for this cluster; an Option exists only where a test or a
// future configuration needs to say otherwise.
type options struct {
	containerName       string
	maxReadBytes        int64
	killGrace           time.Duration
	imagePullSecretName string
}

// Option configures a Sandboxes at construction.
type Option func(*options)

// defaultReadBytes caps how much of a sandbox file Read will hold in worker
// memory. Result files are small JSON; transcripts never come through Read,
// they stream out of the stage's own exec.
const defaultReadBytes int64 = 64 << 20

// defaultOptions is the configuration a Sandboxes has before any Option runs.
func defaultOptions() options {
	return options{
		containerName: "sandbox",
		maxReadBytes:  defaultReadBytes,
		killGrace:     5 * time.Second,
	}
}

// WithMaxReadBytes caps the bytes Read will accept from a sandbox file. A read
// that would exceed the cap fails, aborting the stream, rather than truncating:
// a silently short result is worse than no result.
func WithMaxReadBytes(n int64) Option {
	return func(o *options) { o.maxReadBytes = n }
}

// WithContainerName names the container execs target. It exists because the
// name is a contract with the sandbox image, and a contract deserves a seam.
func WithContainerName(name string) Option {
	return func(o *options) { o.containerName = name }
}

// WithKillGrace sets how long the kill issued on context cancellation waits
// between SIGTERM and SIGKILL.
func WithKillGrace(d time.Duration) Option {
	return func(o *options) { o.killGrace = d }
}

// WithImagePullSecret names the Secret every sandbox pod authenticates its
// image pull with. The sandbox image is private on GHCR (like the worker's
// own), and unlike the worker's Deployment — which sets imagePullSecrets
// explicitly in its Pulumi spec — a pod built by buildPod has no spec of its
// own to edit by hand; this Option is how that same name reaches it.
//
// There is no cluster-side fallback: an empty value here means the pod is
// built with no imagePullSecrets at all, which is a 401 on GHCR's anonymous
// pull path, not a namespace default silently taking over. #404 was exactly
// that assumption turning out false.
func WithImagePullSecret(name string) Option {
	return func(o *options) { o.imagePullSecretName = name }
}
