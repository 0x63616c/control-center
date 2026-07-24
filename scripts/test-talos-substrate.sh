#!/usr/bin/env bash
# Guard for the Talos-substrate gating invariant (Task 4, homelab migration):
# every resource this task adds , local-path-provisioner, MetalLB, the
# `nvidia` RuntimeClass, the Home Assistant workload + its dedicated CNPG
# cluster, and its two backup crons , must construct ONLY inside
# infra/program.ts's `if (target.substrate === "talos")` branch, so an
# untouched ("orbstack", the default and every stack today) apply renders
# ZERO new resources from this task.
#
# This is a STRUCTURAL guard: it runs the infra unit test suite (which
# exercises every new module's Pulumi construction via @pulumi/pulumi's mock
# runtime, plus the serviceSpecs()/renderWorkload() gating tests pinning
# Plex's orbstack spec byte-identical to before this task) and a typecheck.
# It does NOT replace a live `pulumi preview` against the real orbstack
# stack (expected: 143 unchanged resources) , that requires kube/tailnet
# credentials not available in this sandbox; run it manually before merging
# to `main`.
#
# Usage: scripts/test-talos-substrate.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/.."

echo "== typecheck =="
bun run typecheck

echo "== infra unit tests =="
bun run test:unit -- infra/

echo "PASS"
