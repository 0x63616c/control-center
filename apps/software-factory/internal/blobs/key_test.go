package blobs

import "testing"

func TestParseKeyRejectsTraversal(t *testing.T) {
	t.Parallel()

	_, err := ParseKey("payloads/../etc/passwd")
	if err == nil {
		t.Fatal("ParseKey() error = nil, want traversal rejection")
	}
}

func TestParseKeyRejectsUnknownBucket(t *testing.T) {
	t.Parallel()

	_, err := ParseKey("secrets/x")
	if err == nil {
		t.Fatal("ParseKey() error = nil, want unknown bucket rejection")
	}
}

func TestKeyRoundTrip(t *testing.T) {
	t.Parallel()

	key, err := NewKey(BucketPayloads, "job/abc")
	if err != nil {
		t.Fatalf("NewKey() error = %v", err)
	}

	parsed, err := ParseKey(key.String())
	if err != nil {
		t.Fatalf("ParseKey() error = %v", err)
	}
	if parsed != key {
		t.Errorf("ParseKey(Key.String()) = %#v, want %#v", parsed, key)
	}
}

func TestParseKeyRejectsMalformed(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name  string
		value string
	}{
		{name: "empty", value: ""},
		{name: "no path", value: "payloads"},
		{name: "trailing slash", value: "payloads/"},
		{name: "leading slash", value: "/payloads/x"},
		{name: "empty element", value: "payloads//x"},
		{name: "backslash", value: "payloads/a\\b"},
		{name: "dot element", value: "payloads/./x"},
		{name: "nested traversal", value: "payloads/a/../x"},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			_, err := ParseKey(testCase.value)
			if err == nil {
				t.Fatalf("ParseKey(%q) error = nil, want rejection", testCase.value)
			}
		})
	}
}

func TestNewKeyAppliesTheSameValidation(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name   string
		bucket Bucket
		path   string
	}{
		{name: "unknown bucket", bucket: "secrets", path: "x"},
		{name: "empty path", bucket: BucketPayloads, path: ""},
		{name: "trailing slash", bucket: BucketPayloads, path: "x/"},
		{name: "leading slash", bucket: BucketPayloads, path: "/x"},
		{name: "empty element", bucket: BucketPayloads, path: "a//b"},
		{name: "backslash", bucket: BucketPayloads, path: "a\\b"},
		{name: "dot element", bucket: BucketPayloads, path: "./x"},
		{name: "traversal", bucket: BucketPayloads, path: "../etc/passwd"},
		{name: "nested traversal", bucket: BucketPayloads, path: "a/../x"},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			_, err := NewKey(testCase.bucket, testCase.path)
			if err == nil {
				t.Fatalf("NewKey(%q, %q) error = nil, want rejection", testCase.bucket, testCase.path)
			}
		})
	}
}
