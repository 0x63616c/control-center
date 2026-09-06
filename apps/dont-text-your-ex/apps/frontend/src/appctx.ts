import type { DeleteAccountRequest, JarId, ReportId, SessionToken } from "../../../contracts";
import type { MeDTO } from "./types";

export type Route =
  | { readonly name: "onboarding" }
  | { readonly name: "home" }
  | { readonly name: "rescue" }
  | { readonly name: "jar"; readonly jarId: JarId }
  | { readonly name: "logSlip"; readonly jarId: JarId }
  | { readonly name: "report"; readonly jarId: JarId }
  | { readonly name: "confirmDeny"; readonly reportId: ReportId }
  | { readonly name: "reportHistory" }
  | { readonly name: "reportDetail"; readonly reportId: ReportId }
  | { readonly name: "aboutTally"; readonly jarId: JarId }
  | { readonly name: "create" }
  | { readonly name: "join"; readonly code?: string }
  | { readonly name: "invite"; readonly jarId: JarId; readonly fresh?: boolean }
  | { readonly name: "activity" }
  | { readonly name: "profile" }
  | { readonly name: "notificationSettings" }
  | { readonly name: "setup" }
  | { readonly name: "editProfile" };

export type RouteFor<Name extends Route["name"]> = Extract<Route, { readonly name: Name }>;
export type TabName = RouteFor<"onboarding" | "home" | "activity" | "profile">["name"];

/**
 * The single object every screen receives as `ctx`.
 * Screens fetch their own data via the `api` client; this context provides
 * navigation, the current user, auth transitions, and shared UI signals.
 */
export interface AppCtx<CurrentRoute extends Route = Route> {
  me: MeDTO | null;
  setMe: (me: MeDTO) => void;

  route: CurrentRoute;
  /** push a complete, valid route (or replace the whole stack when replaceRoot=true) */
  nav: (route: Route, replaceRoot?: boolean) => void;
  back: () => void;
  /** switch the active bottom tab (also clears the nav stack) */
  tab: (tab: TabName) => void;

  /** auth screens call this after a successful sign-in / verify */
  signIn: (token: SessionToken, me: MeDTO) => void;
  /** resolves only after the server revokes the current bearer session */
  signOut: () => Promise<void>;
  /** accepts durable account deletion, then clears all local authenticated state */
  deleteAccount: (reauthentication?: Omit<DeleteAccountRequest, "confirmed">) => Promise<void>;
  sessionExpired: boolean;

  /** fire the supportive celebration animation (used after logging a slip) */
  fireBurst: () => void;

  /** pending-report badge state for the Activity tab */
  hasPendingReport: boolean;
  refreshPending: () => void;
}
