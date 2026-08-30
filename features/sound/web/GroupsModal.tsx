/** Home Assistant-backed Sound System page with an intentionally literal diagnostic view. */
import { useState } from "react";
import { Alert, Button } from "@/components/ui";
import type { RouterOutputs } from "@/lib/trpc";
import { trpc } from "@/lib/trpc";

type SoundSystemRoom = RouterOutputs["sound"]["soundSystem"]["rooms"][number];

export interface GroupsModalProps {
  rooms: SoundSystemRoom[];
  diagnostics:
    | { kind: "ready"; controlPlane: "home-assistant"; queriedAt: string; message: string }
    | { kind: "error"; message: string };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Home Assistant command failed";
}

type JoinAllActionState =
  | { kind: "ready"; roomCount: number }
  | { kind: "pending"; roomCount: number }
  | { kind: "complete" }
  | { kind: "unavailable" };

export interface JoinAllActionProps {
  state: JoinAllActionState;
  status: string | null;
  onJoin: () => void;
}

export function JoinAllAction({ state, status, onJoin }: JoinAllActionProps) {
  const label =
    state.kind === "pending"
      ? `Joining ${state.roomCount} room${state.roomCount === 1 ? "" : "s"}…`
      : state.kind === "unavailable"
        ? "Desk unavailable"
        : state.kind === "complete"
          ? "All grouped with Desk"
          : "Join all to Desk";
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 12 }}>
      {status && (
        <div role="status" style={{ color: "var(--ink-2)", fontSize: 13 }}>
          {status}
        </div>
      )}
      <Button
        type="button"
        loading={state.kind === "pending"}
        disabled={state.kind === "complete" || state.kind === "unavailable"}
        style={{ width: "auto", minWidth: 180 }}
        onClick={onJoin}
      >
        {label}
      </Button>
    </div>
  );
}

export function GroupsModal({ rooms, diagnostics }: GroupsModalProps) {
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [leaderByRoom, setLeaderByRoom] = useState<Record<string, string>>({});
  const invalidate = () => void utils.sound.soundSystem.invalidate();
  const desk = rooms.find(
    (room) => room.name.trim().toLocaleLowerCase() === "desk" && room.availability === "available",
  );
  const roomsToJoin = desk
    ? rooms.filter(
        (room) =>
          room.availability === "available" &&
          room.uuid !== desk.uuid &&
          room.coordinatorUuid !== desk.uuid,
      )
    : [];
  const joinAll = trpc.sound.sonosGroupJoinAll.useMutation({
    onMutate: () => {
      setError(null);
      setStatus(null);
    },
    onSuccess: () => {
      setStatus("Join command sent. Refreshing group status…");
      invalidate();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const joinAllState: JoinAllActionState = !desk
    ? { kind: "unavailable" }
    : roomsToJoin.length === 0
      ? { kind: "complete" }
      : joinAll.isPending
        ? { kind: "pending", roomCount: roomsToJoin.length }
        : { kind: "ready", roomCount: roomsToJoin.length };
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
      <JoinAllAction
        state={joinAllState}
        status={status}
        onJoin={() => {
          if (!desk || roomsToJoin.length === 0) return;
          joinAll.mutate({
            coordinatorEntityId: desk.deviceIp,
            memberEntityIds: roomsToJoin.map((room) => room.deviceIp),
          });
        }}
      />
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
        {diagnostics.kind === "ready" ? (
          <>
            <div style={{ marginTop: 4, color: "var(--ink-2)", fontSize: 13 }}>
              {diagnostics.message}
            </div>
            <div style={{ marginTop: 4, color: "var(--ink-3)", fontSize: 12 }}>
              Last snapshot: {new Date(diagnostics.queriedAt).toLocaleString()}
            </div>
          </>
        ) : (
          <Alert title="Home Assistant is unavailable">{diagnostics.message}</Alert>
        )}
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
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() =>
                        leave.mutate({ memberIp: room.deviceIp, memberUuid: room.uuid })
                      }
                    >
                      Make standalone
                    </Button>
                  )}
                  {leaders.length > 0 && (
                    <>
                      <select
                        aria-label={`Group ${room.name} with`}
                        value={leaderByRoom[room.uuid] ?? leaders[0]?.uuid ?? ""}
                        onChange={(event) =>
                          setLeaderByRoom((current) => ({
                            ...current,
                            [room.uuid]: event.target.value,
                          }))
                        }
                      >
                        {leaders.map((leader) => (
                          <option key={leader.uuid} value={leader.uuid}>
                            {leader.name}
                          </option>
                        ))}
                      </select>
                      <Button
                        variant="ghost"
                        type="button"
                        onClick={() =>
                          join.mutate({
                            memberIp: room.deviceIp,
                            coordinatorUuid: leaderByRoom[room.uuid] ?? leaders[0]?.uuid ?? "",
                          })
                        }
                      >
                        Join group
                      </Button>
                    </>
                  )}
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
      {error && <Alert title="Audio command failed">{error}</Alert>}
    </div>
  );
}
