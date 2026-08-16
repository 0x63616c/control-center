import {
  JarIdSchema,
  ReportIdSchema,
  RescueInterventionIdSchema,
  SessionTokenSchema,
} from "../../../contracts";
import { api, setToken } from "./api";
import type { AppCtx, Route } from "./appctx";

declare const navigate: AppCtx["nav"];
const jarId = JarIdSchema.parse("jar_123");
const reportId = ReportIdSchema.parse("rpt_123");
const sessionToken = SessionTokenSchema.parse("sess_123");
const rescueId = RescueInterventionIdSchema.parse("rsi_0123456789abcdef0123456789abcdef");
declare const signedInUser: NonNullable<AppCtx["me"]>;

navigate({ name: "home" });
navigate({ name: "rescue" });
navigate({ name: "jar", jarId });
navigate({ name: "invite", jarId, fresh: true });
api.jar(jarId);
api.resolveReport(reportId, "own");
api.rescueCommand(rescueId, "safe");
setToken(sessionToken);
declare const signIn: AppCtx["signIn"];
signIn(sessionToken, signedInUser);

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

// @ts-expect-error API rescue methods preserve the RescueInterventionId brand.
api.rescueCommand(reportId, "safe");

// @ts-expect-error only server-supported rescue commands cross the API boundary.
api.rescueCommand(rescueId, "cancel");

// @ts-expect-error session storage accepts only a parsed SessionToken.
setToken("sess_123");

// @ts-expect-error authentication transitions preserve the SessionToken brand.
signIn("sess_123", signedInUser);

void jarWithoutId;
