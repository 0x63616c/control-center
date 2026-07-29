/**
 * escape-stack , one Escape press closes the topmost surface, and only that one.
 *
 * Every dismissible overlay used to attach its own `window` keydown listener,
 * and window listeners do not nest: with Settings open and a PIN dialog over it,
 * a single Escape ran both handlers and closed both surfaces (#298). Nothing
 * about the individual listeners was wrong , the bug only exists in the
 * composition, which is exactly the kind a component test cannot see.
 *
 * So the arbitration lives here rather than in any one overlay. There is ONE
 * listener for the whole app, holding the open surfaces in the order they
 * opened, and Escape calls the last of them. An overlay opting in cannot get
 * this wrong, and adding a fourth overlay does not add a fourth way to get it
 * wrong either.
 *
 * ORDER IS BY TIME OPENED, not by DOM or React nesting: surfaces on this panel
 * appear one after another because a person taps them into existence. Two
 * overlays mounted in the SAME commit would register child-first, and the
 * outer one would wrongly be treated as topmost. No flow in the app does that;
 * if one ever needs to, this is the assumption to revisit.
 */

import { useEffect, useRef } from "react";

const stack: Array<() => void> = [];
let listening = false;

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  const topmost = stack.at(-1);
  if (!topmost) return;
  topmost();
}

/**
 * Register a surface as the topmost Escape target. Call when it opens; invoke
 * the returned disposer when it closes.
 *
 * The listener is attached only while at least one surface is open, so Escape
 * with nothing up stays untouched by this module.
 */
export function pushEscapeHandler(onEscape: () => void): () => void {
  stack.push(onEscape);
  if (!listening) {
    window.addEventListener("keydown", onKeyDown);
    listening = true;
  }

  let released = false;
  return () => {
    if (released) return; // idempotent: a double cleanup must not evict a peer
    released = true;
    const at = stack.lastIndexOf(onEscape);
    if (at !== -1) stack.splice(at, 1);
    if (stack.length === 0) {
      window.removeEventListener("keydown", onKeyDown);
      listening = false;
    }
  };
}

/**
 * Close this surface on Escape while `active`, and only while it is the topmost
 * open surface.
 *
 * `onEscape` is read through a ref, so a caller passing a fresh closure every
 * render does not re-register , which would silently reorder the stack and hand
 * topmost status to whoever last re-rendered.
 */
export function useEscapeToClose(active: boolean, onEscape: () => void): void {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    return pushEscapeHandler(() => onEscapeRef.current());
  }, [active]);
}
