import { Icon } from "@/components/Icon";
import { Pill, PillTone, Skeleton, Stat, Tile, TileHeader, TileStatus } from "@/components/ui";
import { POLL } from "@/lib/hooks";
import { formatRelativeAge } from "@/lib/relative-age";
import { trpc } from "@/lib/trpc";
import { useTileQuery } from "@/lib/useTileQuery";
import { TeslaMap } from "./tesla-map";

// ── Charging bar ─────────────────────────────────────────────────────────────

interface ChargeProps {
  charging: boolean;
  rate: number;
  pct: number;
  /** Non-null while the car sleeps: label for the Asleep pill ("Asleep · 2hrs"). */
  asleepLabel: string | null;
}

function TeslaCharge({ charging, rate, pct, asleepLabel }: ChargeProps) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          marginBottom: 9,
        }}
      >
        {asleepLabel !== null ? (
          <span className="pill" style={{ padding: "4px 10px" }}>
            <Icon name="moon" s={14} />
            {asleepLabel}
          </span>
        ) : charging ? (
          <span className="pill on" style={{ padding: "4px 10px" }}>
            <Icon name="bolt" s={14} />
            Charging · +{rate} mi/hr
          </span>
        ) : (
          <span className="pill" style={{ padding: "4px 10px" }}>
            Idle
          </span>
        )}
        <span className="mono" style={{ fontSize: 17, fontWeight: 700 }}>
          {pct}%
        </span>
      </div>

      {/* gradient bar */}
      <div
        style={{
          height: 12,
          borderRadius: 7,
          background: "var(--nest)",
          overflow: "hidden",
          border: "1px solid var(--hair)",
        }}
      >
        <div
          data-charge-fill
          // Explicit state flag so tests can assert the charging/idle branch
          // robustly , the gradient itself uses CSS vars that a real browser
          // resolves to rgb (and jsdom drops), so the inline value isn't a
          // stable cross-environment assertion target.
          data-charging={charging ? "true" : "false"}
          style={{
            width: `${pct}%`,
            height: "100%",
            // Green only while charging; gray + no glow when idle.
            background: charging
              ? "linear-gradient(90deg,var(--acc-2),var(--acc))"
              : "linear-gradient(90deg,var(--ink-3),var(--ink-2))",
            borderRadius: 7,
            boxShadow: charging ? "0 0 14px var(--acc-line)" : "none",
          }}
        />
      </div>
    </div>
  );
}

// ── Skeleton layout mirroring the real tile structure ────────────────────────

function TeslaSkeleton() {
  // Mirrors the populated layout: real title up top, lock pill (data-driven)
  // shimmered to its ~25px pill footprint, then map / charge / stats shimmers.
  return (
    <Tile padding={22} style={{ gap: 16 }}>
      <TileHeader icon="car" title="Tesla" right={<Skeleton w={78} h={25} borderRadius={999} />} />
      <div style={{ flex: 1, minHeight: 140 }}>
        <Skeleton w="100%" h="100%" borderRadius={14} />
      </div>
      <Skeleton w="100%" h={32} borderRadius={8} />
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <Skeleton w="30%" h={40} borderRadius={6} />
        <Skeleton w="30%" h={40} borderRadius={6} />
        <Skeleton w="30%" h={40} borderRadius={6} />
      </div>
    </Tile>
  );
}

// ── Offline layout (#42): the car is fully off or unreachable (no signal in a
// multi-story garage), as opposed to "asleep" above, where HA can still see it.
// getTeslaData() throws when even the battery entity is dead, which is the
// server's only signal for "car unreachable" , there is no separate
// asleep-vs-offline distinction available from HA today, so this is a genuine
// error state, not a variant of Populated. ────────────────────────────────────

function TeslaOffline({ lastSeenAt }: { lastSeenAt: string | null }) {
  const age = lastSeenAt ? formatRelativeAge(Date.parse(lastSeenAt), Date.now()) : null;
  return (
    <Tile padding={22} style={{ gap: 16 }}>
      <TileHeader
        icon="car"
        title="Tesla"
        right={
          <Pill tone={PillTone.Amber}>
            <Icon name="wifi-off" s={14} />
            Offline
          </Pill>
        }
      />
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          color: "var(--ink-2)",
        }}
      >
        <Icon name="wifi-off" s={32} c="var(--ink-3)" />
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ink)" }}>Offline</div>
        {/* No fabricated age when we've never seen a successful poll this
            session , honest absence beats a made-up number. */}
        <div style={{ fontSize: 12.5 }}>
          {age ? `Last online ${age} ago` : "Last online unknown"}
        </div>
      </div>
    </Tile>
  );
}

// ── Types ────────────────────────────────────────────────────────────────────

export const TeslaTileStatus = TileStatus;
export type TeslaTileStatus = TileStatus;

export type TeslaTileViewProps =
  | { status: typeof TileStatus.Loading }
  | {
      status: typeof TileStatus.Error;
      /** ISO timestamp of the last successful poll this session; null when
       *  we've never had one (e.g. cold start with the car already unreachable). */
      lastSeenAt?: string | null;
    }
  | {
      status: typeof TileStatus.Populated;
      locked: boolean;
      charging: boolean;
      rate: number;
      pct: number;
      range: number;
      odo: string;
      climate: number;
      lat: number | null;
      lon: number | null;
      place: string;
      /** Car is asleep; every value shown is the last-known snapshot, dimmed. */
      asleep?: boolean;
      /** ISO timestamp of the snapshot the values came from; null when unknown. */
      updatedAt?: string | null;
      /** True when the LATEST poll failed but a prior snapshot is still shown
       *  (www-355t.13 data-first precedence) , distinct from `asleep`, which is
       *  a real HA-reported car state. This is "we don't actually know if this
       *  is still true, the car stopped answering." */
      stale?: boolean;
    };

// ── Pure view ────────────────────────────────────────────────────────────────

export function TeslaTileView(props: TeslaTileViewProps) {
  if (props.status === TileStatus.Loading) return <TeslaSkeleton />;
  if (props.status === TileStatus.Error) {
    return <TeslaOffline lastSeenAt={props.lastSeenAt ?? null} />;
  }

  const { locked, charging, rate, pct, range, odo, climate, lat, lon, place } = props;
  const asleep = props.asleep === true;
  const stale = props.stale === true;
  // While asleep every value is a stale snapshot , suppress the live "charging"
  // treatment (green bar/accent) so stale data never reads as fresh activity.
  // A poll failure (`stale`) is the same situation , the shown values are the
  // last-known snapshot, not confirmed current , so it dims the same way.
  const dimmed = asleep || stale;
  const chargingLive = charging && !dimmed;
  const age =
    asleep && props.updatedAt ? formatRelativeAge(Date.parse(props.updatedAt), Date.now()) : null;
  const asleepLabel = asleep ? (age ? `Asleep · ${age}` : "Asleep") : null;
  const staleAge =
    stale && props.updatedAt ? formatRelativeAge(Date.parse(props.updatedAt), Date.now()) : null;

  return (
    <Tile padding={22} style={{ gap: 16 }}>
      <TileHeader
        icon="car"
        title="Tesla"
        right={
          <span className={`pill${locked ? "" : " amber"}`}>
            <Icon name={locked ? "lock" : "unlock"} s={15} />
            {locked ? "Locked" : "Unlocked"}
          </span>
        }
      />

      {/* stale banner , the poll is currently failing but we still have a last-known
          snapshot to show (data-first precedence, www-355t.13); this is the honest
          "we don't know if this is still true" flag the silent stale-Populated case
          was missing (#42). */}
      {stale && (
        <Pill tone={PillTone.Amber} style={{ alignSelf: "flex-start" }}>
          <Icon name="wifi-off" s={13} />
          {staleAge ? `Offline · synced ${staleAge} ago` : "Offline · last sync unknown"}
        </Pill>
      )}

      {/* map */}
      <div style={{ flex: 1, minHeight: 140 }}>
        <TeslaMap lat={lat} lon={lon} place={place} />
      </div>

      {/* charge + stats , dimmed as a block while the snapshot is stale */}
      <div
        data-asleep={dimmed ? "true" : undefined}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16,
          opacity: dimmed ? 0.55 : 1,
        }}
      >
        {/* charging bar */}
        <TeslaCharge charging={chargingLive} rate={rate} pct={pct} asleepLabel={asleepLabel} />

        {/* stats row */}
        <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 2 }}>
          <Stat label="Range" value={`${range} mi`} accent={chargingLive} muted={!chargingLive} />
          <Stat label="Odometer" value={odo} />
          <Stat label="Cabin" value={`${climate}°F`} />
        </div>
      </div>
    </Tile>
  );
}

// ── Container ────────────────────────────────────────────────────────────────

export function TeslaTile() {
  const raw = trpc.tesla.get.useQuery(undefined, { refetchInterval: POLL.tesla });
  const q = useTileQuery(raw);

  // dataUpdatedAt is react-query's own "when did `data` last actually change"
  // stamp , a real timestamp (0 when there has never been a successful fetch
  // this session), not a fabricated one. It's the only "last seen" signal
  // available today: nothing persists it server-side (#42's open item).
  const lastSeenAt = raw.dataUpdatedAt > 0 ? new Date(raw.dataUpdatedAt).toISOString() : null;

  if (q.status === TileStatus.Loading) return <TeslaTileView status={q.status} />;
  if (q.status === TileStatus.Error) {
    return <TeslaTileView status={q.status} lastSeenAt={lastSeenAt} />;
  }

  const data = q.data;
  return (
    <TeslaTileView
      status={q.status}
      locked={data.locked}
      charging={data.charging}
      rate={data.rate}
      pct={data.pct}
      range={data.range}
      odo={data.odo}
      climate={data.climate}
      lat={data.lat ?? null}
      lon={data.lon ?? null}
      place={data.place ?? ""}
      // The latest poll failed but useTileQuery's data-first precedence
      // (www-355t.13) is still showing this last-known snapshot , flag it as
      // stale rather than let it read as live (#42).
      stale={raw.isError}
      updatedAt={raw.isError ? lastSeenAt : undefined}
    />
  );
}
