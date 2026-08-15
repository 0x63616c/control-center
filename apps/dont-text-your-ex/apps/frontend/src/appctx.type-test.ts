import { JarIdSchema, ReportIdSchema } from "../../../contracts";
import { api } from "./api";
import type { AppCtx, Route } from "./appctx";

declare const navigate: AppCtx["nav"];
const jarId = JarIdSchema.parse("jar_123");
const reportId = ReportIdSchema.parse("rpt_123");

navigate({ name: "home" });
navigate({ name: "jar", jarId });
navigate({ name: "invite", jarId, fresh: true });
api.jar(jarId);
api.resolveReport(reportId, "own");

// @ts-expect-error jar routes always carry the jar they display.
const jarWithoutId: Route = { name: "jar" };

// @ts-expect-error home is a root route and cannot carry jar parameters.
navigate({ name: "home", jarId: "jar_123" });

// @ts-expect-error report routes require a jar id.
navigate({ name: "report" });

// @ts-expect-error confirm/deny routes require a report id, not a jar id.
navigate({ name: "confirmDeny", jarId: "jar_123" });

// @ts-expect-error report ids cannot select jars.
navigate({ name: "jar", jarId: reportId });

// @ts-expect-error jar ids cannot select reports.
navigate({ name: "confirmDeny", reportId: jarId });

// @ts-expect-error API jar methods preserve the JarId brand.
api.jar(reportId);

// @ts-expect-error API report methods preserve the ReportId brand.
api.resolveReport(jarId, "deny");

void jarWithoutId;
