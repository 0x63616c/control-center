package codexresponses

import "errors"

// ErrRateLimited reports that provider capacity cannot serve this run now.
var ErrRateLimited = errors.New("Codex Responses rate limit reached")

// ErrAuth reports that the provider rejected the managed credential.
var ErrAuth = errors.New("Codex Responses authentication failed")
