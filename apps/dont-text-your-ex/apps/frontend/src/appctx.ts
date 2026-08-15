import type { MeDTO } from "./types";

export type ScreenName =
  | "onboarding"
  | "home"
  | "jar"
  | "logSlip"
  | "report"
  | "confirmDeny"
  | "settle"
  | "create"
  | "join"
  | "invite"
  | "activity"
  | "profile"
  | "setup"
  | "editProfile";

export type TabName = "onboarding" | "home" | "activity" | "profile";

export interface Route {
  name: ScreenName;
  params: Record<string, unknown>;
}

/**
 * The single object every screen receives as `ctx`.
 * Screens fetch their own data via the `api` client; this context provides
 * navigation, the current user, auth transitions, and shared UI signals.
 */
export interface AppCtx {
  me: MeDTO | null;
  setMe: (me: MeDTO) => void;

  route: Route;
  /** push a screen (or replace the whole stack when replaceRoot=true) */
  nav: (name: ScreenName, params?: Record<string, unknown>, replaceRoot?: boolean) => void;
  back: () => void;
  /** switch the active bottom tab (also clears the nav stack) */
  tab: (t: TabName) => void;

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
