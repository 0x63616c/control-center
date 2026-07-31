import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { DEFAULT_METRICS_PORT, METRICS_PATH } from "@www/platform/metrics/port";
import { GHCR_PULL_SECRET_NAME } from "./ghcr-pull-secrets.ts";
import {
  assertImageDigestPins,
  composeGhcrDockerConfigJson,
  ghcrImage,
  type ImageDigests,
} from "./services.ts";

export const WEBHOOK_RELAY_NAMESPACE = "webhook-relay";
export function installWebhookRelay(args: {
  provider: k8s.Provider;
  vault: Record<string, string>;
  imageDigests: ImageDigests;
  requireImageDigestPins: boolean;
}): void {
  if (args.requireImageDigestPins) assertImageDigestPins("webhook-relay", args.imageDigests);
  const opts = { provider: args.provider };
  const namespace = new k8s.core.v1.Namespace(
    WEBHOOK_RELAY_NAMESPACE,
    { metadata: { name: WEBHOOK_RELAY_NAMESPACE } },
    opts,
  );
  const namespaceName = namespace.metadata.name;
  const inNamespace = { ...opts, dependsOn: [namespace] };
  const pat = args.vault.GITHUB_PERSONAL_ACCESS_TOKEN__TOKEN;
  if (!pat)
    throw new Error(
      "GITHUB_PERSONAL_ACCESS_TOKEN__TOKEN is required for webhook-relay GHCR pull secret",
    );
  const pull = new k8s.core.v1.Secret(
    GHCR_PULL_SECRET_NAME,
    {
      metadata: { name: GHCR_PULL_SECRET_NAME, namespace: namespaceName },
      type: "kubernetes.io/dockerconfigjson",
      stringData: { ".dockerconfigjson": pulumi.secret(composeGhcrDockerConfigJson(pat)) },
    },
    inNamespace,
  );
  const secretValue = args.vault.GITHUB_BOT_APP__WEBHOOK_SECRET;
  if (!secretValue) throw new Error("GITHUB_BOT_APP__WEBHOOK_SECRET is required for webhook-relay");
  const secret = new k8s.core.v1.Secret(
    "webhook-relay-secrets",
    {
      metadata: { name: "webhook-relay-secrets", namespace: namespaceName },
      stringData: { GITHUB_BOT_WEBHOOK_SECRET: pulumi.secret(secretValue) },
    },
    inNamespace,
  );
  const labels = { app: "webhook-relay" };
  new k8s.core.v1.Service(
    "relay",
    {
      metadata: { name: "relay", namespace: namespaceName },
      spec: { selector: labels, ports: [{ port: 4201, targetPort: 4201 }] },
    },
    inNamespace,
  );
  new k8s.apps.v1.Deployment(
    "relay",
    {
      metadata: { name: "relay", namespace: namespaceName },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: {
            labels,
            annotations: {
              "prometheus.io/scrape": "true",
              "prometheus.io/port": String(DEFAULT_METRICS_PORT),
              "prometheus.io/path": METRICS_PATH,
            },
          },
          spec: {
            automountServiceAccountToken: false,
            imagePullSecrets: [{ name: GHCR_PULL_SECRET_NAME }],
            securityContext: { runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } },
            containers: [
              {
                name: "relay",
                image: ghcrImage("webhook-relay-relay", args.imageDigests),
                ports: [{ containerPort: 4201 }],
                env: [
                  {
                    name: "WEBHOOK_RELAY_TARGETS",
                    value: JSON.stringify([
                      {
                        name: "control-center",
                        url: "http://api.control-center.svc.cluster.local:4201/hooks/github",
                      },
                    ]),
                  },
                  {
                    name: "GITHUB_BOT_WEBHOOK_SECRET",
                    valueFrom: {
                      secretKeyRef: {
                        name: "webhook-relay-secrets",
                        key: "GITHUB_BOT_WEBHOOK_SECRET",
                      },
                    },
                  },
                ],
                readinessProbe: {
                  httpGet: { path: "/health", port: 4201 },
                  initialDelaySeconds: 1,
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
              },
            ],
          },
        },
      },
    },
    { ...inNamespace, dependsOn: [pull, secret] },
  );
}
