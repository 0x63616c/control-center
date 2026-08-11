/** Home Assistant-backed Sound System page with an intentionally literal diagnostic view. */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import type { SoundSystemRoom } from "./lib/derive-sources";

export interface GroupsModalProps {
  rooms: SoundSystemRoom[];
  diagnostics: { controlPlane: "home-assistant"; queriedAt: string; message: string };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Home Assistant command failed";
}

export function GroupsModal({ rooms, diagnostics }: GroupsModalProps) {
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);
  const invalidate = () => void utils.sound.soundSystem.invalidate();
  const join = trpc.sound.sonosGroupJoin.useMutation({
    onSuccess: invalidate,
    onError: (e) => setError(errorMessage(e)),
  });
  const leave = trpc.sound.sonosGroupLeave.useMutation({
    onSuccess: invalidate,
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", display: "grid", gap: 24 }}>
      <section
        style={{
          padding: 16,
          border: "1px solid var(--hair)",
          borderRadius: 14,
          background: "var(--tile-2)",
        }}
      >
        <div style={{ fontSize: 11, letterSpacing: "0.1em", color: "var(--ink-3)" }}>
          AUDIO DIAGNOSTICS
        </div>
        <div style={{ marginTop: 8, fontWeight: 650 }}>Control path: Home Assistant → Sonos</div>
        <div style={{ marginTop: 4, color: "var(--ink-2)", fontSize: 13 }}>
          {diagnostics.message}
        </div>
        <div style={{ marginTop: 4, color: "var(--ink-3)", fontSize: 12 }}>
          Last snapshot: {new Date(diagnostics.queriedAt).toLocaleString()}
        </div>
      </section>

      <section>
        <div
          style={{ fontSize: 11, letterSpacing: "0.1em", color: "var(--ink-3)", marginBottom: 10 }}
        >
          ROOMS
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          {rooms.map((room) => {
            const leaders = rooms.filter(
              (candidate) => candidate.uuid !== room.uuid && candidate.availability === "available",
            );
            return (
              <div
                key={room.uuid}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(180px, 1fr) minmax(150px, 1fr) auto",
                  alignItems: "center",
                  gap: 12,
                  padding: "14px 16px",
                  border: "1px solid var(--hair)",
                  borderRadius: 12,
                }}
              >
                <div>
                  <div style={{ fontWeight: 650 }}>{room.name}</div>
                  <div style={{ marginTop: 3, fontSize: 13, color: "var(--ink-3)" }}>
                    {room.availability === "available"
                      ? room.transportState === "PLAYING"
                        ? "Playing"
                        : room.transportState === "PAUSED_PLAYBACK"
                          ? "Paused"
                          : "Idle (online, not playing)"
                      : room.availability === "unavailable"
                        ? "Unavailable"
                        : "Unknown"}
                    {room.sourceLabel ? ` · ${room.sourceLabel}` : ""}
                  </div>
                </div>
                <div style={{ fontSize: 13, color: "var(--ink-2)" }}>{room.groupStatus}</div>
                <div style={{ display: "flex", gap: 8 }}>
                  {!room.isCoordinator && (
                    <button
                      type="button"
                      onClick={() =>
                        leave.mutate({ memberIp: room.deviceIp, memberUuid: room.uuid })
                      }
                    >
                      Make standalone
                    </button>
                  )}
                  {leaders
                    .filter((leader) => leader.uuid !== room.coordinatorUuid)
                    .slice(0, 1)
                    .map((leader) => (
                      <button
                        key={leader.uuid}
                        type="button"
                        onClick={() =>
                          join.mutate({ memberIp: room.deviceIp, coordinatorUuid: leader.uuid })
                        }
                      >
                        Join {leader.name}
                      </button>
                    ))}
                  {room.isCoordinator &&
                    leaders.every((leader) => leader.uuid === room.coordinatorUuid) && (
                      <span style={{ fontSize: 12, color: "var(--ink-3)" }}>Group leader</span>
                    )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
      {error && (
        <div role="alert" style={{ color: "var(--danger, #d44)" }}>
          {error}
        </div>
      )}
    </div>
  );
}
