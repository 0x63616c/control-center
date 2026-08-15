import type { MeDTO } from "./types";

export type Route =
  | { readonly name: "onboarding" }
  | { readonly name: "home" }
  | { readonly name: "jar"; readonly jarId: string }
  | { readonly name: "logSlip"; readonly jarId: string }
  | { readonly name: "report"; readonly jarId: string }
  | { readonly name: "confirmDeny"; readonly reportId: string }
  | { readonly name: "settle"; readonly jarId: string }
  | { readonly name: "create" }
  | { readonly name: "join" }
  | { readonly name: "invite"; readonly jarId: string; readonly fresh?: boolean }
  | { readonly name: "activity" }
  | { readonly name: "profile" }
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
  signIn: (token: string, me: MeDTO) => void;
  signOut: () => void;
  sessionExpired: boolean;

  /** fire the flying-money animation (used after logging a slip) */
  fireBurst: () => void;

  /** pending-report badge state for the Activity tab */
  hasPendingReport: boolean;
  refreshPending: () => void;
}
