import { useEffect, useRef, useState } from "react";
import { cropProfileImage, type LoadedImage } from "../image-processing";
import { T } from "../theme";
import { Btn } from "../ui";

const VIEWPORT = 280;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function PhotoCropDialog({
  loaded,
  onCancel,
  onUse,
}: {
  loaded: LoadedImage;
  onCancel: () => void;
  onUse: (photo: string) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const cancelled = useRef(false);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        cancelled.current = true;
        onCancel();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => {
      cancelled.current = true;
      window.removeEventListener("keydown", handleEscape);
    };
  }, [onCancel]);

  const constrain = (x: number, y: number, nextZoom = zoom) => {
    const cover = Math.max(
      VIEWPORT / loaded.element.naturalWidth,
      VIEWPORT / loaded.element.naturalHeight,
    );
    const maxX = Math.max(0, (loaded.element.naturalWidth * cover * nextZoom - VIEWPORT) / 2);
    const maxY = Math.max(0, (loaded.element.naturalHeight * cover * nextZoom - VIEWPORT) / 2);
    return { x: clamp(x, -maxX, maxX), y: clamp(y, -maxY, maxY) };
  };

  const changeZoom = (next: number) => {
    const bounded = clamp(next, 1, 3);
    setZoom(bounded);
    setOffset((current) => constrain(current.x, current.y, bounded));
  };

  const usePhoto = async () => {
    if (busy) return;
    setBusy(true);
    cancelled.current = false;
    setError(null);
    const cropped = await cropProfileImage(loaded.element, {
      zoom,
      offset,
      viewportSize: VIEWPORT,
    });
    if (cancelled.current) return;
    if (!cropped.ok) {
      setError("That photo could not be cropped. Try another one.");
      setBusy(false);
      return;
    }
    onUse(cropped.value);
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="crop-title"
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(0,0,0,.88)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div style={{ width: "min(100%, 360px)", textAlign: "center" }}>
        <button
          ref={closeRef}
          type="button"
          aria-label="Cancel cropping"
          onClick={() => {
            cancelled.current = true;
            onCancel();
          }}
          style={{
            width: 44,
            height: 44,
            float: "right",
            background: "none",
            border: 0,
            color: T.text,
            fontSize: 24,
          }}
        >
          ×
        </button>
        <h2 id="crop-title" style={{ fontFamily: T.disp, margin: "8px 44px 18px" }}>
          Crop profile photo
        </h2>
        <button
          type="button"
          aria-label="Move photo crop"
          data-testid="photo-crop-surface"
          onKeyDown={(event) => {
            const movement = 10;
            if (event.key === "ArrowLeft")
              setOffset((current) => constrain(current.x - movement, current.y));
            else if (event.key === "ArrowRight")
              setOffset((current) => constrain(current.x + movement, current.y));
            else if (event.key === "ArrowUp")
              setOffset((current) => constrain(current.x, current.y - movement));
            else if (event.key === "ArrowDown")
              setOffset((current) => constrain(current.x, current.y + movement));
            else return;
            event.preventDefault();
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          }}
          onPointerMove={(event) => {
            const previous = pointers.current.get(event.pointerId);
            if (!previous) return;
            pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
            const active = [...pointers.current.values()];
            if (active.length === 2) {
              const distance = Math.hypot(active[0].x - active[1].x, active[0].y - active[1].y);
              if (!pinch.current) pinch.current = { distance, zoom };
              changeZoom(pinch.current.zoom * (distance / pinch.current.distance));
              return;
            }
            pinch.current = null;
            setOffset((current) =>
              constrain(
                current.x + event.clientX - previous.x,
                current.y + event.clientY - previous.y,
              ),
            );
          }}
          onPointerUp={(event) => {
            pointers.current.delete(event.pointerId);
            pinch.current = null;
          }}
          onPointerCancel={(event) => {
            pointers.current.delete(event.pointerId);
            pinch.current = null;
          }}
          style={{
            width: VIEWPORT,
            height: VIEWPORT,
            borderRadius: "50%",
            overflow: "hidden",
            margin: "0 auto 20px",
            border: `3px solid ${T.gold}`,
            touchAction: "none",
            cursor: "move",
            position: "relative",
            display: "block",
            padding: 0,
            background: "#000",
          }}
        >
          <img
            src={loaded.objectUrl}
            alt="Profile crop preview"
            draggable={false}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
              userSelect: "none",
              pointerEvents: "none",
            }}
          />
        </button>
        <label style={{ display: "block", fontFamily: T.ui, marginBottom: 20 }}>
          Zoom
          <input
            aria-label="Zoom photo"
            type="range"
            min="1"
            max="3"
            step="0.01"
            value={zoom}
            onChange={(event) => changeZoom(Number(event.target.value))}
            style={{ width: "100%", minHeight: 44 }}
          />
        </label>
        {error && (
          <div role="alert" style={{ color: T.red, marginBottom: 12 }}>
            {error}
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Btn
            kind="ghost"
            onClick={() => {
              cancelled.current = true;
              onCancel();
            }}
          >
            Cancel
          </Btn>
          <Btn kind="gold" disabled={busy} onClick={usePhoto}>
            {busy ? "Cropping…" : "Use Photo"}
          </Btn>
        </div>
      </div>
    </div>
  );
}
