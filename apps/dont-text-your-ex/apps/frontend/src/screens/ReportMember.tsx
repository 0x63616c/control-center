import { useCallback, useEffect, useRef, useState } from "react";
import { EVIDENCE_MAX_FILES, type EvidenceImageInput } from "../../../../contracts";
import { api } from "../api";
import type { AppCtx, RouteFor } from "../appctx";
import { EvidenceShot, Toggle } from "../bits";
import { type EvidenceFileError, readEvidenceFiles } from "../evidence-files";
import { Icon } from "../icons";
import { T } from "../theme";
import type { JarDetailDTO, MemberDTO } from "../types";
import { Avatar, Btn, Screen, TopBar } from "../ui";
import { inputStyle, labelStyle } from "./common";
import { ErrorState, type FetchedState, LoadingState, MutationError } from "./fetched-state";

export type ReportServices = Pick<typeof api, "jar" | "createReport">;

type ReportMutationState =
  | { readonly status: "idle" }
  | { readonly status: "submitting"; readonly submission: ReportSubmission }
  | { readonly status: "failed" }
  | { readonly status: "sent"; readonly submission: ReportSubmission };

type ReportSubmission = {
  readonly accusedId: MemberDTO["user"]["id"];
  readonly anonymous: boolean;
};

function assertNever(value: never): never {
  throw new Error(`Unexpected report state: ${JSON.stringify(value)}`);
}

function reportButtonLabel(state: ReportMutationState, anonymous: boolean): string {
  switch (state.status) {
    case "idle":
      return anonymous ? "Send it anonymously" : "Send the report";
    case "submitting":
      return "Sending report…";
    case "failed":
      return "Retry sending report";
    case "sent":
      return "Report sent";
    default:
      return assertNever(state);
  }
}

const EVIDENCE_ERROR_MESSAGE: Record<EvidenceFileError, string> = {
  too_many_files: `Add no more than ${EVIDENCE_MAX_FILES} screenshots.`,
  unsupported_type: "Choose PNG, JPEG, or WebP screenshots.",
  file_too_large: "Each screenshot must be 2 MB or smaller.",
  read_failed: "That screenshot could not be read. Try another file.",
};

export function ReportMember({
  ctx,
  services = api,
}: {
  ctx: AppCtx<RouteFor<"report">>;
  services?: ReportServices;
}) {
  const { jarId } = ctx.route;
  const [jarState, setJarState] = useState<FetchedState<JarDetailDTO>>({ status: "loading" });
  const [target, setTarget] = useState<MemberDTO["user"]["id"] | null>(null);
  const [note, setNote] = useState("");
  const [evidence, setEvidence] = useState<readonly EvidenceImageInput[]>([]);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [readingEvidence, setReadingEvidence] = useState(false);
  const [anon, setAnon] = useState(false);
  const [mutation, setMutation] = useState<ReportMutationState>({ status: "idle" });
  const fileInput = useRef<HTMLInputElement>(null);

  const loadJar = useCallback(() => {
    let alive = true;
    setJarState({ status: "loading" });
    services
      .jar(jarId)
      .then((d) => {
        if (!alive) return;
        setJarState({ status: "loaded", value: d });
        const others = d.members.filter((m) => m.active && m.user.id !== ctx.me?.id);
        setTarget(others[0]?.user.id ?? null);
      })
      .catch(() => {
        if (alive) setJarState({ status: "error" });
      });
    return () => {
      alive = false;
    };
  }, [jarId, ctx.me?.id, services]);

  useEffect(() => loadJar(), [loadJar]);

  const jar = jarState.status === "loaded" ? jarState.value : null;

  const others: MemberDTO[] = (jar?.members ?? []).filter(
    (m) => m.active && m.user.id !== ctx.me?.id,
  );
  const canSend = !!target && (note.trim().length > 0 || evidence.length > 0);

  const selectEvidence = async (files: FileList | null) => {
    const selected = Array.from(files ?? []);
    if (selected.length === 0) return;
    if (evidence.length + selected.length > EVIDENCE_MAX_FILES) {
      setEvidenceError(EVIDENCE_ERROR_MESSAGE.too_many_files);
      return;
    }
    setReadingEvidence(true);
    setEvidenceError(null);
    const result = await readEvidenceFiles(selected);
    setReadingEvidence(false);
    if (!result.ok) {
      setEvidenceError(EVIDENCE_ERROR_MESSAGE[result.error]);
      return;
    }
    setEvidence((current) => [...current, ...result.evidence]);
  };

  const send = async () => {
    if (!canSend || !jar || !target || mutation.status === "submitting") return;
    const submission = { accusedId: target, anonymous: anon } as const;
    setMutation({ status: "submitting", submission });
    try {
      await services.createReport(jar.id, {
        accusedId: target,
        note: note || undefined,
        anonymous: anon,
        amountCents: jar.defaultCents,
        evidence: [...evidence],
      });
      setMutation({ status: "sent", submission });
    } catch {
      setMutation({ status: "failed" });
    }
  };

  if (jarState.status === "loading") {
    return (
      <Screen>
        <TopBar onBack={() => ctx.back()} title="Report a slip" />
        <LoadingState>Loading jar members…</LoadingState>
      </Screen>
    );
  }

  if (jarState.status === "error") {
    return (
      <Screen>
        <TopBar onBack={() => ctx.back()} title="Report a slip" />
        <ErrorState label="Jar members couldn’t be loaded." onRetry={loadJar} />
      </Screen>
    );
  }

  if (jarState.status === "empty" || !jar) return null;

  if (mutation.status === "sent") {
    const p = jar.members.find((m) => m.user.id === mutation.submission.accusedId)?.user;
    return (
      <Screen>
        <div
          style={{
            minHeight: 620,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            gap: 18,
          }}
        >
          <div style={{ fontSize: 56 }}>📨</div>
          <h2
            style={{
              fontFamily: T.disp,
              fontWeight: 800,
              fontSize: 30,
              letterSpacing: "-0.02em",
              margin: 0,
            }}
          >
            Snitched.
          </h2>
          <p style={{ color: T.sec, fontSize: 16, lineHeight: 1.45, maxWidth: 280, margin: 0 }}>
            {mutation.submission.anonymous ? (
              <>
                <b style={{ color: T.text }}>{p?.name}</b> is getting pinged - and they won't know
                it was you. 🤫
              </>
            ) : (
              <>
                <b style={{ color: T.text }}>{p?.name}</b> is getting pinged right now. They can own
                it or deny it.
              </>
            )}
          </p>
          <div style={{ width: "100%", marginTop: 10 }}>
            <Btn kind="gold" onClick={() => ctx.back()}>
              Back to the jar
            </Btn>
          </div>
        </div>
      </Screen>
    );
  }

  return (
    <Screen>
      <TopBar onBack={() => ctx.back()} title="Report a slip" />
      <p style={{ color: T.sec, fontSize: 15, lineHeight: 1.4, margin: "2px 0 22px" }}>
        Caught someone red-handed? Drop the evidence.
      </p>

      <span style={labelStyle}>Who slipped?</span>
      <div style={{ display: "flex", gap: 10, marginBottom: 24, flexWrap: "wrap" }}>
        {others.map((m) => {
          const on = m.user.id === target;
          return (
            <button
              key={m.user.id}
              type="button"
              aria-pressed={on}
              disabled={mutation.status === "submitting"}
              onClick={() => setTarget(m.user.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "8px 14px 8px 8px",
                borderRadius: 999,
                cursor: "pointer",
                background: on ? "rgba(255,210,63,0.12)" : T.surface2,
                border: `1.5px solid ${on ? T.gold : T.hair}`,
              }}
            >
              <Avatar user={m.user} size={28} />
              <span style={{ fontFamily: T.disp, fontWeight: 700, fontSize: 15, color: T.text }}>
                {m.user.name}
              </span>
            </button>
          );
        })}
        {others.length === 0 && (
          <div style={{ color: T.ter, fontSize: 14 }}>
            You're the only one here. Invite someone to snitch on.
          </div>
        )}
      </div>

      <span style={labelStyle}>
        The receipts <span style={{ color: T.ter }}>(screenshots)</span>
      </span>
      <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        {evidence.map((image, index) => (
          <div key={image.dataUrl} style={{ position: "relative" }}>
            <EvidenceShot image={image} w={104} />
            <button
              type="button"
              aria-label={`Remove attachment ${index + 1}`}
              disabled={mutation.status === "submitting"}
              onClick={() => setEvidence((current) => current.filter((_, i) => i !== index))}
              style={{
                position: "absolute",
                top: -12,
                right: -12,
                width: 44,
                height: 44,
                borderRadius: "50%",
                background: T.red,
                border: "2px solid #000",
                color: "#fff",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
              }}
            >
              <Icon.x style={{ width: 12, height: 12 }} />
            </button>
          </div>
        ))}
      </div>
      <div style={{ marginBottom: 24 }}>
        <input
          ref={fileInput}
          data-testid="evidence-input"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          onChange={(event) => {
            void selectEvidence(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
          style={{ display: "none" }}
        />
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={
            readingEvidence ||
            evidence.length >= EVIDENCE_MAX_FILES ||
            mutation.status === "submitting"
          }
          style={{
            width: "100%",
            minHeight: 58,
            borderRadius: 16,
            border: `1.5px dashed ${T.hair}`,
            background: T.surface2,
            color: T.sec,
            cursor: readingEvidence ? "wait" : "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: T.ui,
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          <Icon.plus /> {readingEvidence ? "Reading screenshots…" : "Add screenshots"}
        </button>
        {evidenceError && (
          <div role="alert" style={{ color: T.red, fontSize: 12.5, marginTop: 8 }}>
            {evidenceError}
          </div>
        )}
      </div>

      <span style={labelStyle}>Add what happened</span>
      <textarea
        value={note}
        disabled={mutation.status === "submitting"}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
        placeholder="“replied to her story in 4 seconds flat…”"
        style={{ ...inputStyle, marginBottom: 20 }}
      />

      <div
        data-testid="anon-row"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          background: T.surface,
          border: `1px solid ${T.hair}`,
          borderRadius: 16,
          padding: "14px 16px",
          marginBottom: 14,
        }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: T.disp, fontWeight: 700, fontSize: 15.5 }}>
            Send anonymously 🥷
          </div>
          <div style={{ fontSize: 12.5, color: T.sec, marginTop: 2 }}>
            They'll just see “someone in the jar.”
          </div>
        </div>
        <Toggle
          label="Send anonymously"
          on={anon}
          onChange={setAnon}
          disabled={mutation.status === "submitting"}
        />
      </div>

      {!canSend && (
        <div style={{ fontSize: 12.5, color: T.ter, textAlign: "center", marginBottom: 12 }}>
          Add a note or screenshot to send.
        </div>
      )}
      {mutation.status === "failed" && (
        <MutationError>The report wasn’t sent. Check your connection, then retry.</MutationError>
      )}
      <Btn kind="red" disabled={!canSend || mutation.status === "submitting"} onClick={send}>
        {reportButtonLabel(mutation, anon)}
      </Btn>
    </Screen>
  );
}
