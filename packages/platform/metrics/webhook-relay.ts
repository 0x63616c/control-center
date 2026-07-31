import { Counter, Histogram } from "prom-client";
import { boundedLabel } from "./bounded";
import { metricsRegistry } from "./registry";

const deliveries = new Counter({
  name: "www_webhook_relay_deliveries_total",
  help: "Webhook deliveries accepted by relay.",
  registers: [metricsRegistry],
});
const rejected = new Counter({
  name: "www_webhook_relay_rejected_total",
  help: "Webhook deliveries rejected for invalid signatures.",
  registers: [metricsRegistry],
});
const attempts = new Counter({
  name: "www_webhook_relay_forward_attempts_total",
  help: "Webhook forwarding attempts.",
  labelNames: ["target", "outcome"],
  registers: [metricsRegistry],
});
const givenUp = new Counter({
  name: "www_webhook_relay_forwards_given_up_total",
  help: "Webhook forwards dropped after retries.",
  labelNames: ["target"],
  registers: [metricsRegistry],
});
const latency = new Histogram({
  name: "www_webhook_relay_forward_duration_seconds",
  help: "Webhook forward attempt duration.",
  labelNames: ["target"],
  registers: [metricsRegistry],
});

export function observeWebhookRelayDelivery(): void {
  deliveries.inc();
}
export function observeWebhookRelayRejected(): void {
  rejected.inc();
}
export function observeWebhookRelayForward(
  target: string,
  outcome: string,
  durationSeconds: number,
): void {
  const labels = {
    target: boundedLabel("webhook_relay.target", target),
    outcome: boundedLabel("webhook_relay.outcome", outcome),
  };
  attempts.inc(labels);
  latency.observe({ target: labels.target }, durationSeconds);
}
export function observeWebhookRelayGiveUp(target: string): void {
  givenUp.inc({ target: boundedLabel("webhook_relay.target", target) });
}
