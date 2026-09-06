import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

const DONT_TEXT_YOUR_EX_WORKER_NAME = "dont-text-your-ex-edge";

// Unlike every long-lived edge resource, this single attachment is deliberately
// recoverable: removing it returns /api traffic to the already rate-limited
// Tunnel origin during a Worker incident without changing DNS or tunnel ingress.
export const dontTextYourExWorkerRouteOptions = {
  protect: false,
} satisfies pulumi.CustomResourceOptions;

export function createDontTextYourExWorkerRoute(input: {
  readonly zoneId: pulumi.Input<string>;
  readonly zoneName: pulumi.Input<string>;
  readonly provider?: cloudflare.Provider;
}): cloudflare.WorkersRoute {
  return new cloudflare.WorkersRoute(
    "dont-text-your-ex-edge-route",
    {
      zoneId: input.zoneId,
      pattern: pulumi.interpolate`dont-text-your-ex.${input.zoneName}/api/*`,
      // Wrangler owns the script and RateLimit bindings. Pulumi owns only this
      // route, so neither tool can overwrite the other's resource.
      scriptName: DONT_TEXT_YOUR_EX_WORKER_NAME,
    },
    { ...dontTextYourExWorkerRouteOptions, provider: input.provider },
  );
}
