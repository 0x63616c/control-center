import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppCtx } from "../appctx";
import { Icon } from "../icons";
import { T } from "../theme";
import type { JarDetailDTO } from "../types";
import { Btn, Screen, TopBar } from "../ui";

export function Invite({ ctx }: { ctx: AppCtx }) {
  const jarId = ctx.route.params.jarId as string;
  const fresh = !!ctx.route.params.fresh;
  const [jar, setJar] = useState<JarDetailDTO | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .jar(jarId)
      .then((d) => {
        if (alive) setJar(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [jarId]);

  const code = jar?.inviteCode ?? "······";
  const link = `textyourex.app/j/${code}`;
  const ready = !!jar?.inviteCode;
  const shareText = `Join my "${jar?.name ?? "guilt"}" jar on Text Your Ex. Code: ${code} -> ${link}`;

  const copy = () => {
    if (navigator.clipboard) navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const share = async () => {
    // Native share sheet on iOS WKWebView + web; falls back to copy where unsupported.
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "Text Your Ex", text: shareText, url: `https://${link}` });
        return;
      } catch {
        // user dismissed or unsupported, fall through to copy
      }
    }
    copy();
  };

  return (
    <Screen style={{ display: "flex", flexDirection: "column", paddingBottom: 44 }}>
      <TopBar onBack={() => ctx.back()} title="Invite to jar" />
      {fresh && (
        <div
          style={{
            background: "rgba(48,209,88,0.12)",
            border: `1px solid rgba(48,209,88,0.35)`,
            borderRadius: 16,
            padding: "12px 16px",
            marginBottom: 18,
            fontSize: 14,
            color: T.green,
            fontWeight: 600,
          }}
        >
          ✓ Jar created. Now drag your friends down with you.
        </div>
      )}

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          gap: 18,
        }}
      >
        <div
          style={{
            fontSize: 13,
            color: T.sec,
            fontWeight: 600,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          Your jar code
        </div>
        <button
          type="button"
          onClick={copy}
          style={{
            width: "100%",
            background: T.surface,
            border: `1px solid ${T.hair}`,
            borderRadius: 22,
            padding: "28px 16px",
            cursor: "pointer",
            color: T.text,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 14,
          }}
        >
          <span
            style={{
              fontFamily: T.disp,
              fontWeight: 800,
              fontSize: 56,
              color: T.gold,
              letterSpacing: "0.1em",
            }}
          >
            {code}
          </span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              color: copied ? T.green : T.sec,
              fontFamily: T.ui,
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            {copied ? (
              <>
                <Icon.check style={{ width: 16, height: 16 }} /> Copied to clipboard
              </>
            ) : (
              <>
                <Icon.copy /> Tap to copy code
              </>
            )}
          </span>
        </button>
        <p
          style={{
            textAlign: "center",
            fontSize: 13.5,
            color: T.sec,
            lineHeight: 1.45,
            margin: 0,
            maxWidth: 260,
          }}
        >
          Send the code to your friends. They enter it on "Join a jar" to drag themselves down with
          you.
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, flexShrink: 0 }}>
        <Btn kind="gold" disabled={!ready} onClick={share}>
          Share invite
        </Btn>
      </div>
    </Screen>
  );
}
