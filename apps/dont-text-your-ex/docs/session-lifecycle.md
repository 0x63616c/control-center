# Session lifecycle

Don’t Text Your Ex uses opaque server-side session tokens with this v1 policy:

- Every successful authentication creates a fresh token. Signing in never
  reuses or rotates another device's token.
- A session expires 30 days after creation. Activity updates `last_used_at` for
  operability, but does not extend the absolute expiry.
- Expired tokens are rejected and deleted when presented.
- A user may have multiple independent sessions, such as an iPhone and a second
  browser.
- Logout revokes only the bearer token used for that request. Other sessions
  remain valid.

This document defines backend behavior only. Frontend handling of transient
errors, expired sessions, and logout presentation has separate release evidence.
