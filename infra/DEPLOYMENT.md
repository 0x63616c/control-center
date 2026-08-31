# Production deployment notes

The `home-server` Pulumi stack pins every workload image by immutable digest.
CI updates the entries it can resolve from GHCR and retains existing pins for
unchanged images or temporarily missing tags. Never clear the complete
`wwwinfra:imageDigests` map during a deployment: doing so can unpin unrelated
workloads and causes the production program to reject an incomplete release.

Retiring an image is a deliberate configuration change, not an inference from
a missing registry tag.
