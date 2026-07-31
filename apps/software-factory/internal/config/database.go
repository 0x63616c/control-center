package config

import (
	"net/url"
	"os"
)

// DatabaseURLEnv is the optional PostgreSQL connection string used by database integration tests.
const DatabaseURLEnv = "SOFTWARE_FACTORY_DATABASE_URL"

// DatabaseURL reads the optional PostgreSQL connection string for database integration tests.
func DatabaseURL() string {
	return os.Getenv(DatabaseURLEnv)
}

// databaseURLFromParts builds a postgresql:// connection string from a CNPG
// auth Secret's four values, matching whatever LoadAPI and LoadWorker each
// read their own copies of those four env vars into. Returns "" if any part
// is missing, so a caller can fall back to an explicit URL override.
func databaseURLFromParts(user, password, host, name string) string {
	if user == "" || password == "" || host == "" || name == "" {
		return ""
	}
	return (&url.URL{
		Scheme:   "postgresql",
		User:     url.UserPassword(user, password),
		Host:     host + ":5432",
		Path:     name,
		RawQuery: "sslmode=disable",
	}).String()
}
