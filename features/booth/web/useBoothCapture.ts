/**
 * useBoothCapture , the real "press shutter → maybe count down → capture →
 * upload" state machine for the photo booth. Where the prototype's `useCapture`
 * only animated, this one actually bakes frames off the live <video> and uploads
 * them, so failures are real (a thrown upload surfaces as an on-screen error,
 * per the spec) rather than a swallowed log.
 *
 * Each mode drives a distinct sequence off one shutter press:
 *   - photo: one baked frame.
 *   - burst: 3 frames in fast succession, one shared group.
 *   - four_frame: 4 frames 3s apart (a short posing countdown between each), one
 *     shared group presented as a 2x2 grid in the gallery.
 *   - gif: ~12 frames grabbed rapidly, assembled into a boomerang GIF, uploaded
 *     as a single animation.
 *
 * The self-timer countdown and the between-shot posing countdown both drive the
 * same `count` overlay, with a tick sound per second and a shutter snap at each
 * capture. Multi-frame captures share a client-minted `bpg_<hex>` group id in
 * the exact shape the api validates; photo and gif are single-frame groups and
 * let the backend mint one.
 */

import { genId } from "@www/platform";
import { useEffect, useRef, useState } from "react";
import { playCue } from "@/lib/sound";
import { type CountdownOption, filterCss } from "./camera-model";
import { assembleGif, type BoothMode, bakeFrame, uploadBoothPhoto } from "./lib/booth-capture";

// Sequence timing. Burst is a rapid stutter; four_frame is a paced posing
// interval; the GIF grabs a short window of frames for a smooth boomerang loop.
const BURST_COUNT = 3;
const BURST_INTERVAL_MS = 240;
const FOUR_FRAME_COUNT = 4;
const FOUR_FRAME_GAP_S = 3;
const GIF_FRAME_COUNT = 12;
const GIF_GRAB_INTERVAL_MS = 90;
const GIF_DELAY_MS = 80;
// How long the white flash overlay and the shutter "freeze" cue stay lit.
const FLASH_MS = 220;
const SHUTTER_FREEZE_MS = 300;
// How long the just-captured thumbnail pops near the gallery button before it
// fades out (the ShotThumb animation runs for the same span).
const THUMB_LINGER_MS = 2200;
// How long a capture error lingers on screen before clearing itself.
const ERROR_LINGER_MS = 4000;

/** Mint a group id in the api's `^bpg_[0-9a-z]{1,32}$` shape (matches the backend). */
function newBoothGroupId(): string {
  return genId("bpg", { length: 16 });
}

export interface BoothCaptureArgs {
  /** The live preview element frames are baked from. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  mode: BoothMode;
  /**
   * Active filter id. Non-destructive for stills: stored on the row and applied
   * at display time, not baked into the saved pixels. A gif bakes it in (no
   * display-time filter hook for an assembled animation).
   */
  filterId: string;
  /** Self-timer seconds (0 = immediate). */
  countdown: CountdownOption;
  /** Flash the screen white at each capture moment. */
  flashOn: boolean;
  /**
   * Fired once a shot's uploads have all landed. Uploads go over a raw POST
   * (see lib/booth-capture), not tRPC, so react-query has no idea the listing
   * changed , without this the gallery only picks a new capture up on its next
   * 60s poll, and opening it straight after a shot can show a stale roll.
   */
  onCaptured?: () => void;
}

export interface BoothCaptureController {
  /** Live countdown value; null when no countdown is running. */
  count: number | null;
  /** True for the brief shutter "freeze" window , drives the shutter animation. */
  capturing: boolean;
  /** True for the brief flash window , drives the full-screen white overlay. */
  flashing: boolean;
  /** True for the whole capture sequence , disables controls / re-presses. */
  busy: boolean;
  /** A transient capture error to surface, cleared automatically. */
  error: string | null;
  /**
   * The just-captured frame as an object URL, popped near the gallery button then
   * auto-dismissed , the always-on "your shot landed" cue. `key` is the shot id:
   * it changes once per shutter press, so a fresh shot replays the pop while rapid
   * same-shot frames (burst / gif) only swap the image. Null when nothing recent.
   */
  lastShot: { url: string; key: number } | null;
  /** Press the shutter: runs the timer (if any) then the mode's capture sequence. */
  shoot: () => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function useBoothCapture(args: BoothCaptureArgs): BoothCaptureController {
  const [count, setCount] = useState<number | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [flashing, setFlashing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastShot, setLastShot] = useState<{ url: string; key: number } | null>(null);

  // Synchronous re-entry guard: a second press before React re-renders must not
  // start a second sequence, so a ref (not the async `busy` state) gates shoot.
  const runningRef = useRef(false);
  // Don't touch state after unmount , sequences span seconds of awaits.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Capture the args at press time so a sequence uses the mode/filter/flash the
  // user chose when they pressed, even if they change controls mid-sequence.
  const argsRef = useRef(args);
  argsRef.current = args;

  // Capture-thumbnail plumbing. `shotKeyRef` ids the current shutter press so the
  // pop replays per shot; `thumbUrlRef` holds the one live object URL (revoked on
  // replace / dismiss / unmount so a long kiosk session never leaks blobs).
  const shotKeyRef = useRef(0);
  const thumbUrlRef = useRef<string | null>(null);
  const thumbTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (thumbTimerRef.current) clearTimeout(thumbTimerRef.current);
      if (thumbUrlRef.current) URL.revokeObjectURL(thumbUrlRef.current);
    };
  }, []);

  /** Pop the just-baked frame as the capture thumbnail; auto-dismiss after it settles. */
  function publishThumb(blob: Blob): void {
    if (!aliveRef.current) return;
    const url = URL.createObjectURL(blob);
    // Only the newest thumbnail URL is kept alive.
    if (thumbUrlRef.current) URL.revokeObjectURL(thumbUrlRef.current);
    thumbUrlRef.current = url;
    setLastShot({ url, key: shotKeyRef.current });
    if (thumbTimerRef.current) clearTimeout(thumbTimerRef.current);
    thumbTimerRef.current = setTimeout(() => {
      if (!aliveRef.current) return;
      setLastShot(null);
      if (thumbUrlRef.current) {
        URL.revokeObjectURL(thumbUrlRef.current);
        thumbUrlRef.current = null;
      }
    }, THUMB_LINGER_MS);
  }

  function fireShutterCue(): void {
    playCue("shutter");
    if (argsRef.current.flashOn) {
      setFlashing(true);
      setTimeout(() => {
        if (aliveRef.current) setFlashing(false);
      }, FLASH_MS);
    }
    setCapturing(true);
    setTimeout(() => {
      if (aliveRef.current) setCapturing(false);
    }, SHUTTER_FREEZE_MS);
  }

  /**
   * Bake the current frame. Filters are non-destructive for stills (the saved
   * bytes are RAW; the gallery applies the filter id at display time), so
   * `bakeFilter` is false there and only the mirror + date stamp are baked. A
   * gif has no display-time filter hook (its frames are assembled at capture),
   * so it bakes the filter into pixels , `bakeFilter` true.
   */
  async function bakeCurrent(bakeFilter: boolean): Promise<Blob> {
    const video = argsRef.current.videoRef.current;
    if (!video) throw new Error("Camera not ready");
    const blob = await bakeFrame(video, {
      filterCss: bakeFilter ? filterCss(argsRef.current.filterId) : "none",
      mirror: true,
      stampDate: new Date(),
    });
    // Surface the RAW frame as the capture thumbnail (the gallery applies the
    // filter at display time, so the thumb matches). Skip the filter-baked
    // duplicate a gif produces , its raw grab already published this frame.
    if (!bakeFilter) publishThumb(blob);
    return blob;
  }

  /** The filter id to store on a still, or undefined to store none ("none" = unfiltered). */
  function storedFilter(): string | undefined {
    const id = argsRef.current.filterId;
    return id && id !== "none" ? id : undefined;
  }

  /** Count down `seconds` → 0 with a tick per second, driving the big overlay. */
  async function runCountdown(seconds: number): Promise<void> {
    for (let n = seconds; n > 0; n--) {
      if (!aliveRef.current) return;
      setCount(n);
      playCue("countdownTick");
      await sleep(1000);
    }
    if (aliveRef.current) setCount(null);
  }

  async function capturePhoto(): Promise<void> {
    fireShutterCue();
    const blob = await bakeCurrent(false);
    await uploadBoothPhoto(blob, {
      mode: "photo",
      capturedAt: Date.now(),
      filter: storedFilter(),
    });
  }

  async function captureBurst(): Promise<void> {
    const groupId = newBoothGroupId();
    for (let i = 0; i < BURST_COUNT; i++) {
      if (!aliveRef.current) return;
      fireShutterCue();
      const blob = await bakeCurrent(false);
      await uploadBoothPhoto(blob, {
        mode: "burst",
        groupId,
        capturedAt: Date.now(),
        frameIdx: i,
        filter: storedFilter(),
      });
      if (i < BURST_COUNT - 1) await sleep(BURST_INTERVAL_MS);
    }
  }

  async function captureFourFrame(): Promise<void> {
    const groupId = newBoothGroupId();
    for (let i = 0; i < FOUR_FRAME_COUNT; i++) {
      if (!aliveRef.current) return;
      // First shot fires straight off the shutter press; each later shot gets a
      // short posing countdown so the four are a paced 3s apart.
      if (i > 0) await runCountdown(FOUR_FRAME_GAP_S);
      if (!aliveRef.current) return;
      fireShutterCue();
      const blob = await bakeCurrent(false);
      await uploadBoothPhoto(blob, {
        mode: "four_frame",
        groupId,
        capturedAt: Date.now(),
        frameIdx: i,
        filter: storedFilter(),
      });
    }
  }

  async function captureGif(): Promise<void> {
    fireShutterCue();
    // The gif and its retained raw source frames share a client-minted group id
    // (the .gif upload response returns no group id, and the frames must join it).
    const groupId = newBoothGroupId();
    const filter = storedFilter();
    // Two versions of each grabbed frame: the filter-baked one that assembles the
    // animation (no display-time filter for a gif), and the raw one (mirror +
    // stamp only) retained as an editable source. With no filter they are equal,
    // so grab once and reuse to avoid a needless second bake.
    const animated: Blob[] = [];
    const sources: Blob[] = [];
    for (let i = 0; i < GIF_FRAME_COUNT; i++) {
      if (!aliveRef.current) return;
      const raw = await bakeCurrent(false);
      sources.push(raw);
      animated.push(filter ? await bakeCurrent(true) : raw);
      if (i < GIF_FRAME_COUNT - 1) await sleep(GIF_GRAB_INTERVAL_MS);
    }
    // Bookend the grab with a closing snap so the end of the gif capture is as
    // unmistakable as its start (the gif is one "shot" spanning the grab window).
    if (aliveRef.current) fireShutterCue();
    const gif = await assembleGif(animated, { delayMs: GIF_DELAY_MS, boomerang: true });
    await uploadBoothPhoto(gif, { mode: "gif", groupId, capturedAt: Date.now() });
    // Retain the raw frames under the same group, hidden from the gallery listing
    // (source-only). They carry the filter id since their bytes are unfiltered.
    for (let i = 0; i < sources.length; i++) {
      if (!aliveRef.current) return;
      await uploadBoothPhoto(sources[i], {
        mode: "gif",
        groupId,
        capturedAt: Date.now(),
        frameIdx: i,
        filter,
        sourceOnly: true,
      });
    }
  }

  function runMode(mode: BoothMode): Promise<void> {
    switch (mode) {
      case "photo":
        return capturePhoto();
      case "burst":
        return captureBurst();
      case "four_frame":
        return captureFourFrame();
      case "gif":
        return captureGif();
    }
  }

  function shoot(): void {
    if (runningRef.current) return;
    runningRef.current = true;
    // New shutter press , new shot id, so the thumbnail pop replays for this shot.
    shotKeyRef.current += 1;
    setBusy(true);
    setError(null);

    void (async () => {
      try {
        const { countdown, mode } = argsRef.current;
        if (countdown > 0) await runCountdown(countdown);
        if (!aliveRef.current) return;
        await runMode(mode);
        // Uploads are done , tell the host so it can refresh the listing.
        argsRef.current.onCaptured?.();
      } catch (err) {
        if (aliveRef.current) {
          setError(err instanceof Error ? err.message : "Capture failed");
          setTimeout(() => {
            if (aliveRef.current) setError(null);
          }, ERROR_LINGER_MS);
        }
      } finally {
        runningRef.current = false;
        if (aliveRef.current) {
          setBusy(false);
          setCount(null);
        }
      }
    })();
  }

  return { count, capturing, flashing, busy, error, lastShot, shoot };
}
