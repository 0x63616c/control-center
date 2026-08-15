import type { AppCtx, Route } from "./appctx";

declare const navigate: AppCtx["nav"];

navigate({ name: "home" });
navigate({ name: "jar", jarId: "jar_123" });
navigate({ name: "invite", jarId: "jar_123", fresh: true });

// @ts-expect-error jar routes always carry the jar they display.
const jarWithoutId: Route = { name: "jar" };

// @ts-expect-error home is a root route and cannot carry jar parameters.
navigate({ name: "home", jarId: "jar_123" });

// @ts-expect-error report routes require a jar id.
navigate({ name: "report" });

// @ts-expect-error confirm/deny routes require a report id, not a jar id.
navigate({ name: "confirmDeny", jarId: "jar_123" });

void jarWithoutId;
