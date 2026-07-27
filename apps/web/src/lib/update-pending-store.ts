/**
 * update-pending-store , tiny signal for "a version-check reload is about to
 * fire" (see version-check.ts). Separated from version-check.ts itself so
 * that module stays a plain, hook-free, unit-testable poll loop; the store is
 * the only thing that needs React.
 */

import { createStore, useStore } from "./store";

const store = createStore(false);

/** Mark a reload as imminent (or clear the flag). version-check.ts only. */
export function setUpdatePending(pending: boolean): void {
  store.set(pending);
}

/** True while a version-check reload is scheduled but hasn't fired yet. */
export function useUpdatePending(): boolean {
  return useStore(store);
}
