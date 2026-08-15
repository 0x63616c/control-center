require_relative "release_entitlements"

PRODUCTION_DOMAIN = "applinks:dont-text-your-ex.worldwidewebb.co"

def assert(message, value)
  abort("FAIL: #{message}") unless value
end

assert(
  "exact associated domain is allowed",
  ReleaseEntitlements.profile_allows_associated_domain?([PRODUCTION_DOMAIN], PRODUCTION_DOMAIN)
)

assert(
  "wildcard associated-domains capability is allowed",
  ReleaseEntitlements.profile_allows_associated_domain?(["*"], PRODUCTION_DOMAIN)
)

assert(
  "missing associated-domains capability is rejected",
  !ReleaseEntitlements.profile_allows_associated_domain?([], PRODUCTION_DOMAIN)
)

assert(
  "unrelated associated domain is rejected",
  !ReleaseEntitlements.profile_allows_associated_domain?(
    ["applinks:example.invalid"],
    PRODUCTION_DOMAIN
  )
)

puts "release entitlement verifier: 4 checks passed"
