require_relative "release_metadata"

def assert_equal(message, expected, actual)
  abort("FAIL: #{message}: expected #{expected.inspect}, got #{actual.inspect}") unless actual == expected
end

assert_equal(
  "external releases preserve the supplied changelog",
  "Restored v1 beta",
  ReleaseMetadata.testflight_changelog(external: true, changelog: "Restored v1 beta")
)

assert_equal(
  "internal releases do not require a changelog",
  nil,
  ReleaseMetadata.testflight_changelog(external: false, changelog: nil)
)

begin
  ReleaseMetadata.testflight_changelog(external: true, changelog: "  ")
  abort("FAIL: external releases reject an empty changelog")
rescue ArgumentError
  # Expected.
end

puts "release metadata: 3 checks passed"
