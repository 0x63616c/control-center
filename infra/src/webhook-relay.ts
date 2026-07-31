// The public GitHub webhook relay. It is a stateless platform edge service: it
// shares the Go module with software-factory but owns neither factory state nor
// a factory namespace.

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
import { FACTORY_WEBHOOK_TARGET_URL } from "./software-factory.ts";

/** WEBHOOK_RELAY_NAMESPACE isolates the public relay from its consumers. */
export const WEBHOOK_RELAY_NAMESPACE = "webhook-relay";

const RELAY_NAME = "relay";
const RELAY_SECRET_NAME = "webhook-relay-secrets";
const RELAY_PORT = 8080;
const METRICS_ADDR = `:${DEFAULT_METRICS_PORT}`;

export interface WebhookRelayArgs {
  provider: k8s.Provider;
  vault: Record<string, string>;
  imageDigests: ImageDigests;
  requireImageDigestPins: boolean;
}

export interface WebhookRelayResources {
  namespace: k8s.core.v1.Namespace;
  relay: k8s.apps.v1.Deployment;
  service: k8s.core.v1.Service;
}

/** installWebhookRelay installs the isolated, stateless GitHub webhook edge. */
export function installWebhookRelay(args: WebhookRelayArgs): WebhookRelayResources {
  const { provider, vault, imageDigests, requireImageDigestPins } = args;
  const opts = { provider };
  if (requireImageDigestPins) assertImageDigestPins("software-factory", imageDigests);

  const pullToken = vault.GITHUB_PERSONAL_ACCESS_TOKEN__TOKEN;
  const webhookSecret = vault.GITHUB_BOT_APP__WEBHOOK_SECRET;
  if (!pullToken)
    throw new Error("webhook-relay: vault key GITHUB_PERSONAL_ACCESS_TOKEN__TOKEN not found");
  if (!webhookSecret)
    throw new Error("webhook-relay: vault key GITHUB_BOT_APP__WEBHOOK_SECRET not found");

  const namespace = new k8s.core.v1.Namespace(
    WEBHOOK_RELAY_NAMESPACE,
    { metadata: { name: WEBHOOK_RELAY_NAMESPACE } },
    opts,
  );
  const namespaceName = namespace.metadata.name;
  const inNamespace = { ...opts, dependsOn: [namespace] };
  const pullSecret = new k8s.core.v1.Secret(
    "webhook-relay-ghcr-pull",
    {
      metadata: { name: GHCR_PULL_SECRET_NAME, namespace: namespaceName },
      type: "kubernetes.io/dockerconfigjson",
      stringData: { ".dockerconfigjson": pulumi.secret(composeGhcrDockerConfigJson(pullToken)) },
    },
    inNamespace,
  );
  const secret = new k8s.core.v1.Secret(
    RELAY_SECRET_NAME,
    {
      metadata: { name: RELAY_SECRET_NAME, namespace: namespaceName },
      stringData: { GITHUB_BOT_APP__WEBHOOK_SECRET: pulumi.secret(webhookSecret) },
    },
    inNamespace,
  );
  const labels = { app: RELAY_NAME };
  const relay = new k8s.apps.v1.Deployment(
    RELAY_NAME,
    {
      metadata: { name: RELAY_NAME, namespace: namespaceName, labels },
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
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 65532,
              runAsGroup: 65532,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name: RELAY_NAME,
                image: ghcrImage("software-factory-relay", imageDigests),
                ports: [{ name: "http", containerPort: RELAY_PORT }],
                env: [
                  { name: "LISTEN_ADDR", value: `:${RELAY_PORT}` },
                  { name: "METRICS_ADDR", value: METRICS_ADDR },
                  {
                    name: "RELAY_TARGETS",
                    value: JSON.stringify([
                      {
                        name: "control-center",
                        url: "http://api.control-center.svc.cluster.local:4201/hooks/github",
                      },
                      // #557: the factory's own webhook consumer, so a merged
                      // pull request marks its Ticket done. See
                      // internal/webhook's own doc comment for why it stays
                      // outside the API's normal auth and verifies the HMAC
                      // itself.
                      { name: "software-factory", url: FACTORY_WEBHOOK_TARGET_URL },
                    ]),
                  },
                  {
                    name: "GITHUB_BOT_APP__WEBHOOK_SECRET",
                    valueFrom: {
                      secretKeyRef: {
                        name: RELAY_SECRET_NAME,
                        key: "GITHUB_BOT_APP__WEBHOOK_SECRET",
                      },
                    },
                  },
                ],
                readinessProbe: {
                  httpGet: { path: "/healthz", port: "http" },
                  initialDelaySeconds: 1,
                  periodSeconds: 5,
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
                resources: { requests: { cpu: "25m", memory: "32Mi" }, limits: { memory: "64Mi" } },
              },
            ],
          },
        },
      },
    },
    { ...inNamespace, dependsOn: [pullSecret, secret] },
  );
  const service = new k8s.core.v1.Service(
    RELAY_NAME,
    {
      metadata: { name: RELAY_NAME, namespace: namespaceName, labels },
      spec: { selector: labels, ports: [{ name: "http", port: RELAY_PORT, targetPort: "http" }] },
    },
    { ...inNamespace, dependsOn: [relay] },
  );
  return { namespace, relay, service };
}
