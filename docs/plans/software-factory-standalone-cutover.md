# Software Factory standalone cutover checklist

## Current state

- Standalone extraction PR `0x63616c/software-factory#2` is merged.
- The merged standalone tree is the durable `AgentWorkflow` architecture using
  direct Responses calls. The retired Codex CLI execution design is not active.
- The previous standalone prototype is preserved under root-level `_archived/`
  and excluded from active build, lint, code generation, and test surfaces.
- Software Factory remains unlicensed for now. Do not add a license as part of
  this cutover without a separate decision.
- `v0.1.0` is the extraction baseline. Later WWW workflow updates belong in a
  standalone `v0.1.1` follow-up after they finish and are reconciled.

## Release `v0.1.0`

- [ ] Require the standalone merge commit's own main CI run to pass.
- [ ] Tag that exact main commit as `v0.1.0` and push only the tag.
- [ ] Require the tag-triggered release workflow to pass.
- [ ] Verify the non-draft GitHub Release contains the release manifest and
  `SHA256SUMS`.
- [ ] Verify the manifest binds `v0.1.0` to the tagged commit, `linux/amd64`,
  and exactly seven expected images with immutable `sha256:` digests.
- [ ] Verify all seven SemVer image tags resolve to the manifest digests.

## WWW consumer cutover

- [ ] Rebase the consumer-cutover branch onto current `origin/main` without
  overwriting Calum's workflow changes.
- [ ] Verify the GitHub Release provenance, checksum, and tag-to-commit binding
  before accepting its manifest.
- [ ] Map the exact seven released image digests to the existing Pulumi digest
  keys deterministically.
- [ ] Replace embedded-build image ownership with the released standalone
  digests while keeping the existing runtime configuration and secrets wiring.
- [ ] Adapt Gate 10 to prove the standalone release identity, exact deployed
  digests, required standalone CI/release evidence, and durable
  `AgentWorkflow` runtime path.
- [ ] Validate the Pulumi preview and all relevant repository checks.
- [ ] Open a first WWW PR for immutable release consumption and the adapted
  Gate 10 proof.
- [ ] Merge only with green CI, deploy `home-server`, and capture production
  proof before deleting the embedded implementation.

## Embedded ownership removal

- [ ] Open a follow-up WWW PR removing `apps/software-factory/` active source.
- [ ] Remove WWW CI path filters, image builds, code generation, lint, tests,
  and contributor documentation that claim ownership of the embedded product.
- [ ] Retain only deployment/consumer integration that is still required by
  the standalone release.
- [ ] Confirm no active WWW surface imports, builds, or tests the removed Go
  module or revives the retired Codex CLI design.
- [ ] Run the final adapted Gate 10 proof after merge and production deploy.

## Follow-up `v0.1.1`

- [ ] Wait for Calum's WWW workflow updates to merge.
- [ ] Reconcile the applicable changes into the standalone repository.
- [ ] Run standalone verification, deterministic E2E, Temporal Session, and all
  seven image builds.
- [ ] Release `v0.1.1` through the same immutable SemVer mechanism.
- [ ] Update WWW to the verified `v0.1.1` digest set in a normal consumer PR.
