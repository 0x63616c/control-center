import { Skeleton, Tile, TileHeader, TileStatus } from "@/components/ui";

export interface WakesTileViewProps {
  status: TileStatus;
  /** Wakes captured today (UTC day, matching the api's day buckets). */
  todayCount?: number;
  /** "14:32"-style label of the most recent wake, null when none yet. */
  lastWakeLabel?: string | null;
}

/**
 * Deliberately subtle wake-photos tile: a bare count, no thumbnails , the
 * photos themselves only appear in the full-page viewer behind the tap (opened
 * by the board via the tile-detail registry, behind the PIN gate).
 * (Design call 2026-07-17: nothing on the board should look like a camera.)
 */
export function WakesTileView({ status, todayCount, lastWakeLabel }: WakesTileViewProps) {
  const isLoading = status === TileStatus.Loading || status === TileStatus.Error;

  return (
    <Tile padding={22}>
      {/* Title MUST stay in sync with the App manifest label. */}
      <TileHeader icon="moon" title="Activity" />
      <div style={{ marginTop: "auto" }}>
        {isLoading ? (
          <Skeleton w={72} h={44} />
        ) : (
          <div style={{ fontSize: 44, fontWeight: 600, lineHeight: 1 }}>{todayCount ?? 0}</div>
        )}
        <div className="cap" style={{ marginTop: 8 }}>
          {isLoading ? (
            <Skeleton w={110} h={12} />
          ) : lastWakeLabel ? (
            `today · last ${lastWakeLabel}`
          ) : (
            "today · none yet"
          )}
        </div>
      </div>
    </Tile>
  );
}
