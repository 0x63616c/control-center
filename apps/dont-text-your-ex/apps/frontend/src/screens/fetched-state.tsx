import type { ReactNode } from "react";
import { T } from "../theme";

export type FetchedState<T> =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly value: T }
  | { readonly status: "empty" }
  | { readonly status: "error" };

export function LoadingState({ children = "Loading…" }: { children?: ReactNode }) {
  return (
    <div role="status" style={{ textAlign: "center", color: T.ter, padding: "60px 0" }}>
      {children}
    </div>
  );
}

export function ErrorState({ label, onRetry }: { label: string; onRetry: () => void }) {
  return (
    <div role="alert" style={{ textAlign: "center", padding: "48px 0" }}>
      <div style={{ color: T.sec, fontSize: 15, marginBottom: 14 }}>{label}</div>
      <button
        type="button"
        onClick={onRetry}
        style={{
          border: `1px solid ${T.hair}`,
          borderRadius: 14,
          padding: "10px 18px",
          background: T.surface2,
          color: T.gold,
          fontFamily: T.ui,
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        Retry
      </button>
    </div>
  );
}

export function MutationError({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      style={{ color: T.red, fontSize: 13.5, textAlign: "center", margin: "12px 0" }}
    >
      {children}
    </div>
  );
}
