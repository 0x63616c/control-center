// Package codexauth owns the model provider's OAuth credential: it is the only
// thing in this service that holds a refresh token, and the only thing that
// refreshes one.
//
// That exclusivity is the design. The refresh token is single-use and rotating,
// and the CLI holds no cross-process lock around its credential file, so two
// processes sharing one credential eventually invalidate each other. The worker
// runs single-replica, which makes "one writer" structural rather than a rule
// somebody has to remember; sandboxes are handed an access token only, with the
// refresh token blanked.
package codexauth

import "context"

// SecretStore reads and writes the keys of the one Kubernetes Secret holding
// the credential.
//
// Which Secret that is — namespace and name — is bound when the implementation
// is constructed, not passed per call. A caller cannot address a different
// Secret through this seam, which is what keeps the blast radius of the only
// component holding a refresh token down to a single object.
//
// Put must be durable before it returns. The stored refresh token is
// single-use: if a rotation is performed and the new token is lost, the old one
// is already spent, and recovery is a human running a browser login.
type SecretStore interface {
	Get(ctx context.Context, key string) ([]byte, error)
	Put(ctx context.Context, key string, value []byte) error
}
