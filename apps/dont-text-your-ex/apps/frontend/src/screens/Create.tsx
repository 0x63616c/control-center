import { useState } from "react";
import { api } from "../api";
import type { AppCtx, RouteFor } from "../appctx";
import { Stepper } from "../bits";
import { T } from "../theme";
import { Btn, Screen, TopBar } from "../ui";
import { inputStyle, labelStyle } from "./common";
import { MutationError } from "./fetched-state";

export type CreateServices = Pick<typeof api, "createJar">;

export function Create({
  ctx,
  services = api,
}: {
  ctx: AppCtx<RouteFor<"create">>;
  services?: CreateServices;
}) {
  const [name, setName] = useState("");
  const [rule, setRule] = useState("");
  const [cents, setCents] = useState(500);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(false);
    try {
      const jar = await services.createJar({
        name: name.trim(),
        rule: rule.trim() || undefined,
        defaultCents: cents,
      });
      ctx.nav({ name: "invite", jarId: jar.id, fresh: true });
    } catch {
      setBusy(false);
      setError(true);
    }
  };

  return (
    <Screen style={{ display: "flex", flexDirection: "column", paddingBottom: 44 }}>
      <TopBar onBack={() => ctx.back()} title="New jar" />
      <p style={{ color: T.sec, fontSize: 15, lineHeight: 1.4, margin: "2px 0 24px" }}>
        Round up the friends who'll keep you honest.
      </p>

      <span style={labelStyle}>Jar name</span>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="“The Group Chat”"
        style={{ ...inputStyle, marginBottom: 22 }}
      />

      <span style={labelStyle}>
        The rule <span style={{ color: T.ter }}>(set the tone)</span>
      </span>
      <textarea
        value={rule}
        onChange={(e) => setRule(e.target.value)}
        rows={2}
        placeholder="“Don't text your ex. We mean it.”"
        style={{ ...inputStyle, marginBottom: 22 }}
      />

      <span style={labelStyle}>Cost per slip</span>
      <div
        style={{
          background: T.surface,
          border: `1px solid ${T.hair}`,
          borderRadius: 20,
          padding: "22px 0",
        }}
      >
        <Stepper cents={cents} onChange={setCents} step={100} />
      </div>

      <div style={{ flex: 1, minHeight: 24 }} />
      {error && (
        <MutationError>
          The jar couldn’t be created. Check your connection, then retry with the same details.
        </MutationError>
      )}
      <Btn kind="gold" disabled={!name.trim() || busy} onClick={create}>
        {busy ? "Creating jar…" : error ? "Retry creating jar" : "Create jar & invite friends"}
      </Btn>
    </Screen>
  );
}
