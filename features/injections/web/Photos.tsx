import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { trpc } from "@/lib/trpc";
import { type Photo, POSES, type RecordSet, type Weight } from "../model";
import { ErrorMessage, Field } from "./Forms";
import { dateLabel, number } from "./Timeline";

const src = (id: string) => `/media/progress-photos/${id}`;
export function PhotoGuides({ pose }: { pose: Photo["pose"] }) {
  return (
    <svg className="ij-guides" viewBox="0 0 600 800" preserveAspectRatio="none" aria-hidden="true">
      <path
        d="M300 25V780 M130 112H470 M110 735H490"
        stroke="white"
        opacity=".55"
        strokeDasharray="8 8"
        fill="none"
      />
      <ellipse cx="300" cy="135" rx="43" ry="55" />
      <path
        d={
          pose === "side"
            ? "M285 190 Q250 245 273 420 L264 710 M315 190 Q355 260 326 420 L325 710 M276 230 L285 445"
            : "M275 190 Q213 200 205 260 L180 430 L211 442 L251 286 L248 452 L236 710 L272 710 L300 480 L328 710 L364 710 L352 452 L349 286 L389 442 L420 430 L395 260 Q387 200 325 190"
        }
      />
      <ellipse cx="256" cy="733" rx="26" ry="13" />
      <ellipse cx="344" cy="733" rx="26" ry="13" />
    </svg>
  );
}

export function Photos({
  data,
  weights,
  selected,
  onRefresh,
}: {
  data: RecordSet;
  weights: Weight[];
  selected: number;
  onRefresh: () => void;
}) {
  const [capture, setCapture] = useState(false),
    [pose, setPose] = useState<Photo["pose"]>("front");
  const photos = data.photos.filter((p) => p.pose === pose);
  const nearest = [...photos].sort(
    (a, b) => Math.abs(Date.parse(a.at) - selected) - Math.abs(Date.parse(b.at) - selected),
  )[0];
  const [firstId, setFirstId] = useState(""),
    [secondId, setSecondId] = useState("");
  const first = photos.find((p) => p.id === firstId) ?? photos[0],
    second = photos.find((p) => p.id === secondId) ?? nearest ?? photos.at(-1);
  const reference = [...photos].reverse().find((p) => p.reference) ?? photos[0];
  const [mode, setMode] = useState("side"),
    [opacity, setOpacity] = useState(50),
    [error, setError] = useState<unknown>(null),
    [removeId, setRemoveId] = useState<string | null>(null);
  const refMutation = trpc.injections.photoReference.useMutation(),
    remove = trpc.injections.deletePhoto.useMutation();
  const weight = (photo: Photo) => weights.find((w) => w.id === photo.weightId);
  const caption = (photo: Photo) => {
    const w = weight(photo);
    return `${dateLabel(photo.at, data.course.timezone)}${w ? ` · ${number(w.kg * 2.2046226218, 1)} lb` : " · no linked weight"}`;
  };
  return (
    <section className="ij-card">
      <div className="ij-row">
        <h2>Progress photos</h2>
        <Button onClick={() => setCapture(!capture)}>
          {capture ? "Close camera" : "Take progress photo"}
        </Button>
      </div>
      <div className="ij-actions">
        {POSES.map((p) => (
          <button
            className="ij-pill"
            aria-pressed={pose === p}
            type="button"
            key={p}
            onClick={() => setPose(p)}
          >
            {p}
          </button>
        ))}
      </div>
      {capture ? (
        <Capture
          data={data}
          weights={weights}
          pose={pose}
          reference={reference}
          onSaved={() => {
            setCapture(false);
            onRefresh();
          }}
        />
      ) : photos.length === 0 ? (
        <p className="ij-muted">
          No {pose} photos yet. The first photo becomes your alignment reference. Photos are
          optional.
        </p>
      ) : (
        <>
          <div className="ij-form-grid">
            <Field label="Before">
              <select value={first?.id ?? ""} onChange={(e) => setFirstId(e.target.value)}>
                {photos.map((p) => (
                  <option key={p.id} value={p.id}>
                    {caption(p)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="After">
              <select value={second?.id ?? ""} onChange={(e) => setSecondId(e.target.value)}>
                {photos.map((p) => (
                  <option key={p.id} value={p.id}>
                    {caption(p)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="ij-actions">
            {[
              { id: "side", label: "Side by side" },
              { id: "slider", label: "Before / after" },
              { id: "overlay", label: "Onion skin" },
            ].map((m) => (
              <button
                type="button"
                className="ij-pill"
                aria-pressed={mode === m.id}
                key={m.id}
                onClick={() => setMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
          {first && second && (
            <>
              <div className={`ij-photo-compare ${mode === "side" ? "side" : "overlay"}`}>
                <img src={src(first.id)} alt={`Before, ${caption(first)}`} />
                <img
                  src={src(second.id)}
                  alt={`After, ${caption(second)}`}
                  style={
                    mode === "overlay"
                      ? { opacity: opacity / 100 }
                      : mode === "slider"
                        ? { clipPath: `inset(0 ${100 - opacity}% 0 0)` }
                        : undefined
                  }
                />
              </div>
              {mode !== "side" && (
                <Field label={mode === "slider" ? "Reveal after photo" : "After photo opacity"}>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={opacity}
                    onChange={(e) => setOpacity(Number(e.target.value))}
                  />
                </Field>
              )}
              <div className="ij-row">
                <span>{caption(first)}</span>
                <span>
                  {caption(second)}
                  {weight(first) && weight(second)
                    ? ` · ${number(((weight(second)?.kg ?? 0) - (weight(first)?.kg ?? 0)) * 2.2046226218, 1)} lb`
                    : ""}
                </span>
              </div>
              <p>{second.notes}</p>
              <div className="ij-actions">
                <Button
                  variant="ghost"
                  loading={refMutation.isPending}
                  onClick={async () => {
                    try {
                      await refMutation.mutateAsync({
                        id: second.id,
                        courseId: data.course.id,
                        reference: true,
                      });
                      onRefresh();
                    } catch (e) {
                      setError(e);
                    }
                  }}
                >
                  Use after photo as reference
                </Button>
                <Button variant="ghost" onClick={() => setRemoveId(second.id)}>
                  Remove after photo
                </Button>
              </div>
            </>
          )}
          {removeId && (
            <div className="ij-note">
              <p>Remove this progress photo from the gallery?</p>
              <div className="ij-actions">
                <Button
                  variant="ghost"
                  loading={remove.isPending}
                  onClick={async () => {
                    try {
                      await remove.mutateAsync({ id: removeId, courseId: data.course.id });
                      setRemoveId(null);
                      onRefresh();
                    } catch (e) {
                      setError(e);
                    }
                  }}
                >
                  Confirm removal
                </Button>
                <Button variant="ghost" onClick={() => setRemoveId(null)}>
                  Keep photo
                </Button>
              </div>
            </div>
          )}
        </>
      )}
      <ErrorMessage error={error} />
    </section>
  );
}

function Capture({
  data,
  weights,
  pose,
  reference,
  onSaved,
}: {
  data: RecordSet;
  weights: Weight[];
  pose: Photo["pose"];
  reference?: Photo;
  onSaved: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null),
    stream = useRef<MediaStream | null>(null),
    alive = useRef(true);
  const [ready, setReady] = useState(false),
    [error, setError] = useState<unknown>(null),
    [count, setCount] = useState<number | null>(null),
    [busy, setBusy] = useState(false),
    [seconds, setSeconds] = useState(10),
    [ghost, setGhost] = useState(25),
    [notes, setNotes] = useState("");
  const [weightId, setWeightId] = useState(
    weights.filter((w) => Date.parse(w.at) <= Date.now()).at(-1)?.id ?? "",
  );
  const [preview, setPreview] = useState<{ blob: Blob; url: string; at: string } | null>(null);
  useEffect(() => {
    alive.current = true;
    let disposed = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        new Error("Camera unavailable. Open this panel over HTTPS and allow camera access."),
      );
      return;
    }
    void navigator.mediaDevices
      .getUserMedia({
        audio: false,
        video: { facingMode: "user", width: { ideal: 1200 }, height: { ideal: 1600 } },
      })
      .then((s) => {
        if (disposed) {
          s.getTracks().forEach((t) => {
            t.stop();
          });
          return;
        }
        stream.current = s;
        if (video.current) video.current.srcObject = s;
      })
      .catch(setError);
    return () => {
      disposed = true;
      alive.current = false;
      stream.current?.getTracks().forEach((t) => {
        t.stop();
      });
    };
  }, []);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );
  async function take() {
    setBusy(true);
    setError(null);
    try {
      for (let i = seconds; i > 0; i--) {
        if (!alive.current) return;
        setCount(i);
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!alive.current) return;
      setCount(null);
      const v = video.current;
      if (!v?.videoWidth) throw new Error("Camera is not ready");
      const canvas = document.createElement("canvas");
      const ratio = Math.min(1, 1600 / Math.max(v.videoWidth, v.videoHeight));
      canvas.width = Math.round(v.videoWidth * ratio);
      canvas.height = Math.round(v.videoHeight * ratio);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Cannot capture camera frame");
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.9),
      );
      if (!blob) throw new Error("Could not encode photo");
      if (alive.current)
        setPreview({ blob, url: URL.createObjectURL(blob), at: new Date().toISOString() });
    } catch (e) {
      if (alive.current) setError(e);
    } finally {
      if (alive.current) {
        setBusy(false);
        setCount(null);
      }
    }
  }
  async function upload() {
    if (!preview) return;
    setBusy(true);
    try {
      const response = await fetch("/media/progress-photo", {
        method: "POST",
        headers: {
          "Content-Type": "image/jpeg",
          "x-photo-meta": JSON.stringify({
            courseId: data.course.id,
            at: preview.at,
            pose,
            notes,
            weightId: weightId || null,
          }),
        },
        body: preview.blob,
      });
      if (!response.ok)
        throw new Error(
          `Photo upload failed (${response.status}). Your capture is still here; try again.`,
        );
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <div>
      <p className="ij-muted">
        Match head height, center line and feet. Move closer or farther until your outline matches.
        Keep the iPad in the same position. The saved photo contains no guides.
      </p>
      <div className="ij-camera">
        <video
          ref={video}
          autoPlay
          playsInline
          muted
          onLoadedData={() => setReady(true)}
          style={{ visibility: preview ? "hidden" : "visible" }}
        />
        {preview ? (
          <img
            className="ij-camera-layer"
            src={preview.url}
            alt="Captured progress photo, ready to save"
          />
        ) : (
          <>
            {reference && (
              <img
                className="ij-camera-layer"
                src={src(reference.id)}
                alt="Alignment reference"
                style={{ opacity: ghost / 100 }}
              />
            )}
            <PhotoGuides pose={pose} />
          </>
        )}
        {count !== null && (
          <strong className="ij-count" aria-live="assertive">
            {count}
          </strong>
        )}
      </div>
      <div className="ij-form-grid">
        <Field label="Countdown">
          <select
            disabled={busy}
            value={seconds}
            onChange={(e) => setSeconds(Number(e.target.value))}
          >
            {[3, 5, 10, 20].map((n) => (
              <option key={n} value={n}>
                {n} seconds
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reference ghost opacity">
          <input
            type="range"
            min="0"
            max="70"
            value={ghost}
            onChange={(e) => setGhost(Number(e.target.value))}
          />
        </Field>
        <Field label="Associated weight">
          <select value={weightId} onChange={(e) => setWeightId(e.target.value)}>
            <option value="">No weight linked</option>
            {weights
              .slice(-90)
              .reverse()
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {dateLabel(w.at, data.course.timezone)} · {number(w.kg * 2.2046226218, 1)} lb
                </option>
              ))}
          </select>
        </Field>
        <Field label="Photo note">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
      <ErrorMessage error={error} />
      {preview ? (
        <div className="ij-actions">
          <Button loading={busy} onClick={() => void upload()}>
            Save progress photo
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setPreview(null)}>
            Retake
          </Button>
        </div>
      ) : (
        <Button disabled={!ready} loading={busy} onClick={() => void take()}>
          {busy ? `Capturing in ${count ?? 0}…` : `Take ${pose} photo · ${seconds}s timer`}
        </Button>
      )}
    </div>
  );
}
