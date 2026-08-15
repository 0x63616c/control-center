import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppCtx } from "../appctx";
import { Icon } from "../icons";
import { money, T } from "../theme";
import type { JarSummaryDTO, UserDTO } from "../types";
import { AvatarStack, IconBtn, Screen, TopBar } from "../ui";

export function Home({ ctx }: { ctx: AppCtx }) {
  const [jars, setJars] = useState<JarSummaryDTO[] | null>(null);
  // member user objects for avatar stacks come from each jar detail lazily;
  // for the list we only need ids + a color, which the summary doesn't carry,
  // so we resolve avatars from a small members map fetched alongside.
  const [members, setMembers] = useState<Record<string, UserDTO>>({});

  useEffect(() => {
    let alive = true;
    api
      .jars()
      .then(async (js) => {
        if (!alive) return;
        setJars(js);
        // hydrate avatars: pull each jar detail once to learn member users
        const map: Record<string, UserDTO> = {};
        await Promise.all(
          js.map(async (j) => {
            try {
              const d = await api.jar(j.id);
              for (const m of d.members) map[m.user.id] = m.user;
            } catch {
              /* ignore */
            }
          }),
        );
        if (alive) setMembers(map);
      })
      .catch(() => setJars([]));
    return () => {
      alive = false;
    };
  }, []);

  const myTotal = (jars ?? []).reduce((s, j) => s + j.myTallyCents, 0);
  const bestStreak = (jars ?? []).reduce((max, j) => Math.max(max, j.myDaysClean), 0);

  return (
    <Screen>
      <TopBar
        title="Your jars"
        trailing={
          <IconBtn data-testid="create-jar" onClick={() => ctx.nav("create")}>
            <Icon.plus />
          </IconBtn>
        }
      />

      <div
        style={{
          background: "linear-gradient(135deg, #1c1606, #100c02)",
          border: `1px solid ${T.hair}`,
          borderRadius: 24,
          padding: "20px 22px",
          marginBottom: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div>
          <div style={{ fontSize: 13.5, color: T.sec, fontWeight: 600, marginBottom: 4 }}>
            Your total damage
          </div>
          <div
            data-testid="total-damage"
            style={{
              fontFamily: T.disp,
              fontWeight: 800,
              fontSize: 44,
              color: T.gold,
              letterSpacing: "-0.03em",
              lineHeight: 1,
            }}
          >
            {money(myTotal)}
          </div>
        </div>
        <div
          style={{
            alignSelf: "stretch",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            justifyContent: "space-between",
            textAlign: "right",
          }}
        >
          <div
            style={{
              fontFamily: T.disp,
              fontWeight: 800,
              fontSize: 44,
              color: T.green,
              lineHeight: 1,
              letterSpacing: "-0.03em",
            }}
          >
            {bestStreak}
          </div>
          <div style={{ fontSize: 12, color: T.sec, fontWeight: 600 }}>days clean</div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {(jars ?? []).map((j) => {
          const memberUsers = j.memberIds.map((id) => members[id]).filter(Boolean);
          return (
            <button
              key={j.id}
              type="button"
              data-testid="jar-card"
              data-jar-name={j.name}
              onClick={() => ctx.nav("jar", { jarId: j.id })}
              style={{
                textAlign: "left",
                background: T.surface,
                border: `1px solid ${T.hair}`,
                borderRadius: 24,
                padding: 20,
                cursor: "pointer",
                color: T.text,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                }}
              >
                <div
                  style={{
                    fontFamily: T.disp,
                    fontWeight: 700,
                    fontSize: 22,
                    letterSpacing: "-0.02em",
                  }}
                >
                  {j.name}
                </div>
                <Icon.chev style={{ color: T.ter, marginTop: 6 }} />
              </div>
              <div
                style={{ display: "flex", alignItems: "center", gap: 10, margin: "14px 0 18px" }}
              >
                {memberUsers.length > 0 ? (
                  <AvatarStack users={memberUsers} size={30} />
                ) : (
                  <div style={{ height: 30 }} />
                )}
                <span style={{ fontSize: 13.5, color: T.sec, fontWeight: 600 }}>
                  {j.memberCount} in
                </span>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <div
                  style={{
                    flex: 1,
                    background: T.surface2,
                    borderRadius: 14,
                    padding: "11px 14px",
                  }}
                >
                  <div style={{ fontSize: 11.5, color: T.sec, fontWeight: 600, marginBottom: 2 }}>
                    You owe
                  </div>
                  <div
                    style={{
                      fontFamily: T.disp,
                      fontWeight: 700,
                      fontSize: 22,
                      color: j.myTallyCents ? T.gold : T.sec,
                    }}
                  >
                    {money(j.myTallyCents)}
                  </div>
                </div>
                <div
                  style={{
                    flex: 1,
                    background: T.surface2,
                    borderRadius: 14,
                    padding: "11px 14px",
                  }}
                >
                  <div style={{ fontSize: 11.5, color: T.sec, fontWeight: 600, marginBottom: 2 }}>
                    Jar total
                  </div>
                  <div style={{ fontFamily: T.disp, fontWeight: 700, fontSize: 22 }}>
                    {money(j.jarTotalCents)}
                  </div>
                </div>
              </div>
            </button>
          );
        })}

        {jars && jars.length === 0 && (
          <div
            style={{
              textAlign: "center",
              color: T.sec,
              fontSize: 15,
              padding: "20px 0 8px",
              lineHeight: 1.5,
            }}
          >
            No jars yet. Start one and drag your friends down with you.
          </div>
        )}

        <button
          type="button"
          onClick={() => ctx.nav("join")}
          style={{
            background: "transparent",
            border: `1.5px dashed ${T.hair}`,
            borderRadius: 24,
            padding: 18,
            cursor: "pointer",
            color: T.sec,
            fontFamily: T.ui,
            fontWeight: 600,
            fontSize: 15,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
          }}
        >
          <Icon.plus style={{ width: 16, height: 16 }} /> Join a jar with a code
        </button>
      </div>
    </Screen>
  );
}
