import { useState } from "react";
import { api } from "../api";
import type { AppCtx } from "../appctx";
import { Stepper } from "../bits";
import { T } from "../theme";
import { Btn, Screen, TopBar } from "../ui";
import { inputStyle, labelStyle } from "./common";

export function Create({ ctx }: { ctx: AppCtx }) {
  const [name, setName] = useState("");
  const [rule, setRule] = useState("");
  const [cents, setCents] = useState(500);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const jar = await api.createJar({
        name: name.trim(),
        rule: rule.trim() || undefined,
        defaultCents: cents,
      });
      ctx.nav("invite", { jarId: jar.id, fresh: true });
    } catch {
      setBusy(false);
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
      <Btn kind="gold" disabled={!name.trim() || busy} onClick={create}>
        Create jar & invite friends
      </Btn>
    </Screen>
  );
}
