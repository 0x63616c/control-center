// `kubernetes-sigs/agent-sandbox` CRDs + controller (program handoff step 1,
// software-factory migration: /tmp/handoffs/2026-07-29-software-factory-migration-program.md,
// issue #432). Installs the `Sandbox` CRD (`agents.x-k8s.io/v1beta1`) plus
// `SandboxTemplate`, `SandboxClaim`, and `SandboxWarmPool` (a separate group,
// `extensions.agents.x-k8s.io/v1beta1` — confirmed against the pinned v0.5.3
// manifest) that a later step will use to schedule VM-isolated (`kata`
// RuntimeClass, infra/src/kata.ts) software-factory agent work. This step
// installs the CRDs + controller ONLY
// — no `Sandbox` custom resource is created by Pulumi here; the software
// factory itself changes nothing in this step. The acceptance-test `Sandbox`
// this program step uses to prove Kata isolation works is a throwaway applied
// by hand and deleted, never a checked-in resource.
//
// `agent-sandbox` is pre-1.0 (v0.5.3): the API graduated `v1alpha1` ->
// `v1beta1` with a documented breaking change
// (`Sandbox.spec.volumeClaimTemplates` now immutable after creation), and an
// earlier v0.5.0/v0.5.1 advisory flagged a status-wiping race on warm-started
// claims, fixed by v0.5.2. Pin the exact tag, never a branch ref or `main` —
// same reasoning as certmanager.ts's version pin. No Helm chart upstream; this
// reuses certmanager.ts's `k8s.yaml.ConfigFile`-pointed-at-a-pinned-release-URL
// pattern rather than a hand-run `kubectl apply -f`.

import * as k8s from "@pulumi/kubernetes";

// Exported (not just internal) so tests can assert the pinned tag directly,
// same reasoning as NVIDIA_RUNTIME_CLASS_NAME in nvidia.ts — a single source
// of truth a test can check without re-deriving the URL by hand.
export const AGENT_SANDBOX_VERSION = "v0.5.3";

export interface AgentSandboxArgs {
  provider: k8s.Provider;
}

export interface AgentSandboxResources {
  install: k8s.yaml.ConfigFile;
}

/**
 * @public - installs the agent-sandbox CRDs + controller from the pinned
 * upstream release manifest. Consumed by program.ts, gated to the "talos"
 * substrate (same as installKataRuntimeClass — the two are unrelated to each
 * other in Pulumi terms, but both exist only to support the same later
 * software-factory sandboxing step).
 */
export function installAgentSandboxCrds(args: AgentSandboxArgs): AgentSandboxResources {
  const { provider } = args;
  const install = new k8s.yaml.ConfigFile(
    "agent-sandbox",
    {
      file: `https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/sandbox-with-extensions.yaml`,
    },
    { provider },
  );
  return { install };
}
