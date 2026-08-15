module ReleaseMetadata
  module_function

  def testflight_changelog(external:, changelog:)
    return nil unless external

    value = changelog.to_s.strip
    raise ArgumentError, "External TestFlight distribution requires a changelog" if value.empty?

    value
  end
end
