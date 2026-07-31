// Package blobs defines the typed, validation-only namespace for stored blobs.
package blobs

import (
	"fmt"
	"strings"
)

// Bucket is what a blob is for. It is a closed set: a new bucket is a
// deliberate edit to this file, never a string a caller invents.
type Bucket string

// BucketPayloads holds payload blobs.
const BucketPayloads Bucket = "payloads"

// Key names one blob.
type Key struct {
	Bucket Bucket
	Path   string // Slash-separated; never a leading or trailing slash.
}

// NewKey constructs a validated blob key.
func NewKey(bucket Bucket, path string) (Key, error) {
	if err := validate(bucket, path); err != nil {
		return Key{}, err
	}

	return Key{Bucket: bucket, Path: path}, nil
}

// ParseKey parses the external <bucket>/<path> representation of a key.
func ParseKey(value string) (Key, error) {
	bucket, path, found := strings.Cut(value, "/")
	if !found {
		return Key{}, fmt.Errorf("parse blob key %q: missing bucket/path separator", value)
	}

	key, err := NewKey(Bucket(bucket), path)
	if err != nil {
		return Key{}, fmt.Errorf("parse blob key %q: %w", value, err)
	}

	return key, nil
}

// String returns the canonical <bucket>/<path> representation of k.
func (k Key) String() string {
	return string(k.Bucket) + "/" + k.Path
}

func validate(bucket Bucket, path string) error {
	switch bucket {
	case BucketPayloads:
	default:
		return fmt.Errorf("unknown blob bucket %q", bucket)
	}

	if path == "" {
		return fmt.Errorf("blob path is empty")
	}
	if strings.Contains(path, "\\") {
		return fmt.Errorf("blob path %q contains a backslash", path)
	}
	if strings.HasPrefix(path, "/") || strings.HasSuffix(path, "/") {
		return fmt.Errorf("blob path %q has a leading or trailing slash", path)
	}

	for _, element := range strings.Split(path, "/") {
		switch element {
		case "":
			return fmt.Errorf("blob path %q contains an empty element", path)
		case ".", "..":
			return fmt.Errorf("blob path %q contains reserved element %q", path, element)
		}
	}

	return nil
}
