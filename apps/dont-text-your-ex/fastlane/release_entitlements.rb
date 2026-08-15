module ReleaseEntitlements
  module_function

  def profile_allows_associated_domain?(profile_domains, expected_domain)
    profile_domains.include?(expected_domain) || profile_domains.include?("*")
  end
end
