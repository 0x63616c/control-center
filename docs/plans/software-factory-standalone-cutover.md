# Software Factory standalone cutover checklist

## Current state

- Standalone extraction PR `0x63616c/software-factory#2` is merged.
- The merged standalone tree is the durable `AgentWorkflow` architecture using
  direct Responses calls. The retired Codex CLI execution design is not active.
- The previous standalone prototype is preserved under root-level `_archived/`
  and excluded from active build, lint, code generation, and test surfaces.
- Software Factory remains unlicensed for now. Do not add a license as part of
  this cutover without a separate decision.
- WWW's GitHub CodeQL Default Setup no longer includes Go now that this repo has
  no active Go source; its other configured languages remain enabled.
- The immutable `v0.1.0` tag is the failed first release attempt. Its gate
  stopped before publishing because the runner lacked `ripgrep`; no images or
  GitHub Release were published, and the tag was not moved.
- `v0.1.1` is the first published extraction release. Its manifest, checksum,
  exact seven-image set, and promoted registry digests were independently
  verified.
- WWW PRs #670 and #671 were ported as exactly two commits and merged through
  standalone PR #4. That line belongs in a `v0.1.2` follow-up.

## Release baseline

- [x] Require the standalone release commit's own main CI run to pass.
- [x] Preserve the failed `v0.1.0` tag without moving or republishing it.
- [x] Fix the missing release-gate dependency through standalone PR #3.
- [x] Tag the exact green fix commit as `v0.1.1` and push only the tag.
- [x] Require the tag-triggered release workflow to pass.
- [x] Verify the non-draft GitHub Release contains the release manifest and
  `SHA256SUMS`.
- [x] Verify the manifest binds `v0.1.1` to the tagged commit, `linux/amd64`,
  and exactly seven expected images with immutable `sha256:` digests.
- [x] Verify all seven SemVer image tags resolve to the manifest digests.

## WWW consumer cutover

- [x] Rebase the consumer-cutover branch onto current `origin/main` without
  overwriting Calum's workflow changes.
- [x] Verify the GitHub Release provenance, checksum, and tag-to-commit binding
  before accepting its manifest.
- [x] Map the exact seven released image digests to the existing Pulumi digest
  keys deterministically.
- [x] Replace embedded-build image ownership with the released standalone
  digests while keeping the existing runtime configuration and secrets wiring.
- [x] Adapt Gate 10 to prove the standalone release identity, exact deployed
  digests, required standalone CI/release evidence, and durable
  `AgentWorkflow` runtime path.
- [x] Validate the Pulumi preview and all relevant repository checks.
- [x] Open WWW PR #673 for immutable release consumption and the adapted
  Gate 10 proof.
- [x] Merge only with green CI, deploy `home-server`, and capture production
  proof before deleting the embedded implementation.

## Embedded ownership removal

- [x] Open WWW PR #674 removing `apps/software-factory/` active source.
- [x] Remove WWW CI path filters, image builds, code generation, lint, tests,
  and contributor documentation that claim ownership of the embedded product.
- [x] Retain only deployment/consumer integration that is still required by
  the standalone release.
- [x] Confirm no active WWW surface imports, builds, or tests the removed Go
  module or revives the retired Codex CLI design.
- [ ] Run the final adapted Gate 10 proof after merge and production deploy.

## Follow-up `v0.1.2`

- [x] Wait for Calum's WWW workflow updates to merge.
- [x] Reconcile the applicable changes into the standalone repository as one
  commit per source PR in standalone PR #4.
- [x] Run standalone verification and two-axis review before opening PR #4.
- [x] Review and merge standalone PR #4 with green CI.
- [x] Run standalone verification, deterministic E2E, Temporal Session, and all
  seven image builds on its merge commit.
- [x] Release `v0.1.2` through the same immutable SemVer mechanism.
- [x] Update the WWW consumer branch to the verified release digest set.
