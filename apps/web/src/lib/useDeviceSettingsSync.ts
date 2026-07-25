/**
 * useDeviceSettingsSync , bridges the local per-device store (lib/device-settings)
 * with this panel's server-persisted row.
 *
 * Same two directions as useSettingsSync, and the same in-flight guard, but
 * every call is keyed on this panel's device_id so panels never read or write
 * each other's values:
 *
 *  - Server → store: adopt the stored row on load and on each poll, unless a
 *    local write is mid-flight.
 *  - Store → server: an edit fires the store's sink; edits are debounced into a
 *    single mutation so dragging the volume slider isn't a write per frame.
 *
 * Ticket #63 folded the device NAME into this same round trip, even though it
 * lives in a separate local store (lib/device-name.ts, not device-settings.ts ,
 * see that file's header for why). Two things beyond the volume flow above:
 *
 *  - A one-time upward MIGRATION: a panel that already had a local name before
 *    server persistence existed needs it pushed once. Each poll first checks
 *    `nameToMigrate`; if it returns a name, that pass pushes-and-marks-migrated
 *    and skips hydration entirely so the just-pushed local name can't be
 *    clobbered by the (still-empty) server value this same tick, then the NEXT
 *    poll picks up the now-populated row normally.
 *  - A second debounced push effect, sibling to the volume one, sharing this
 *    hook's mutateRef/inFlight so both fields funnel through the same
 *    in-flight guard and debounce window.
 *
 * Mount ONCE, inside the tRPC + Query providers (see app.tsx).
 */

import { useEffect, useRef } from "react";
import { getDeviceId } from "./device-id";
import {
  hydrateDeviceName,
  markDeviceNameMigrated,
  nameToMigrate,
  registerNameServerSink,
} from "./device-name";
import { type DeviceSettings, hydrateDeviceSettings, registerServerSink } from "./device-settings";
import { POLL } from "./hooks";
import { trpc } from "./trpc";

const PUSH_DEBOUNCE_MS = 400;

export function useDeviceSettingsSync(): void {
  const utils = trpc.useUtils();
  // Sync (cached, never throws) , safe to call during render, and stable for the
  // life of the app, so it can key the query without a fetch-then-enable dance.
  const deviceId = getDeviceId();

  const query = trpc.deviceSettings.get.useQuery({ deviceId }, { refetchInterval: POLL.settings });
  const mutation = trpc.deviceSettings.set.useMutation();

  const mutateRef = useRef(mutation.mutate);
  mutateRef.current = mutation.mutate;

  // Count of in-flight local writes; while >0 we skip server→store hydration so
  // a poll that raced the write can't overwrite what the user just changed.
  const inFlight = useRef(0);

  const data = query.data;
  useEffect(() => {
    if (!data || inFlight.current !== 0) return;

    // Migration check runs FIRST, strictly before any hydration touches local
    // state: if there is a legacy local name to push, push it and stop , do
    // not hydrate volume/name from this (pre-migration) snapshot at all. The
    // next poll, after the mutation lands, will see the server's own name.
    const migrateName = nameToMigrate(data.name);
    if (migrateName !== null) {
      inFlight.current += 1;
      mutateRef.current(
        { deviceId, patch: { name: migrateName } },
        {
          onSettled: () => {
            markDeviceNameMigrated();
            inFlight.current = Math.max(0, inFlight.current - 1);
            void utils.deviceSettings.get.invalidate({ deviceId });
          },
        },
      );
      return;
    }

    hydrateDeviceName(data.name);
    hydrateDeviceSettings(data);
  }, [data, deviceId, utils]);

  useEffect(() => {
    let timer = 0;
    let pending: DeviceSettings | null = null;
    const flush = () => {
      const payload = pending;
      pending = null;
      if (!payload) return;
      inFlight.current += 1;
      mutateRef.current(
        { deviceId, patch: payload },
        {
          onSettled: () => {
            inFlight.current = Math.max(0, inFlight.current - 1);
            void utils.deviceSettings.get.invalidate({ deviceId });
          },
        },
      );
    };
    const unregister = registerServerSink((next) => {
      pending = next;
      window.clearTimeout(timer);
      timer = window.setTimeout(flush, PUSH_DEBOUNCE_MS);
    });
    return () => {
      window.clearTimeout(timer);
      unregister();
    };
  }, [utils, deviceId]);

  useEffect(() => {
    let timer = 0;
    let pending: string | null = null;
    const flush = () => {
      const name = pending;
      pending = null;
      if (name === null) return;
      inFlight.current += 1;
      mutateRef.current(
        { deviceId, patch: { name } },
        {
          onSettled: () => {
            inFlight.current = Math.max(0, inFlight.current - 1);
            void utils.deviceSettings.get.invalidate({ deviceId });
          },
        },
      );
    };
    const unregister = registerNameServerSink((name) => {
      pending = name;
      window.clearTimeout(timer);
      timer = window.setTimeout(flush, PUSH_DEBOUNCE_MS);
    });
    return () => {
      window.clearTimeout(timer);
      unregister();
    };
  }, [utils, deviceId]);
}
