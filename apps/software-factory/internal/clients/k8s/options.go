package k8s

import "time"

// options is the tunable part of a Sandboxes. Everything here has a default
// that is correct for this cluster; an Option exists only where a test or a
// future configuration needs to say otherwise.
type options struct {
	containerName string
	maxReadBytes  int64
	killGrace     time.Duration
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
