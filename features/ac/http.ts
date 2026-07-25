import { defineHttp } from "@app-kit";
import { getClimate } from "./service";

/**
 * Deploy-health probe target (www-hya3) (Track C fold , moved off the
 * hardcoded server.ts ladder onto the S3 route table). The deploy `verify`
 * step curls this to prove the api can reach live Home Assistant, decoupled
 * from the tRPC wire format so a procedure rename can't silently turn the
 * probe advisory-red (which is how the old /api/climate.now probe rotted).
 * getClimate() throws on an HA outage or misconfig (services-throw
 * convention), surfacing as a 500 -> red probe. CORS is overlaid centrally by
 * server.ts's route-table iterator; do NOT set it here (mirrors
 * features/wakes/http.ts).
 */
export const routes = defineHttp([
  {
    method: "GET",
    path: "/health/climate",
    match: "exact",
    handler: async () => {
      const { ambient } = await getClimate();
      return Response.json({ ambient }, { status: 200 });
    },
  },
]);
