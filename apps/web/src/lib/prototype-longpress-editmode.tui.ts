// PROTOTYPE — throwaway TUI shell. Run: `bun run proto:longpress` (see apps/web/package.json).
// Answers: does the long-press/edit-mode state machine in
// prototype-longpress-editmode.logic.ts feel right when driven by hand? Not
// production code, not tested, delete after the question is answered (see
// issue #71 / SKILL.md "Capture it when done").
//
// Keys are simulated pointer events, not real touch — this is a terminal, not a panel:
//   [d] pointerDown   [m] pointerMove (small)   [M] pointerMove (big, past cancel threshold)
//   [u] pointerUp     [t] advance clock 100ms   [r] reset   [q] quit

import {
  entersEditMode,
  initialLongPressState,
  LONG_PRESS_THRESHOLD_MS,
  type LongPressAction,
  type LongPressState,
  longPressReducer,
  MOVE_CANCEL_THRESHOLD_PX,
} from "./prototype-longpress-editmode.logic";

let state: LongPressState = initialLongPressState();
let clockMs = 0;
let editModeFlips = 0;
const log: string[] = [];

function dispatch(action: LongPressAction) {
  const prev = state;
  if (entersEditMode(prev, action)) editModeFlips++;
  state = longPressReducer(state, action);
  log.push(`${action.type} @${clockMs}ms -> ${state.phase}`);
  if (log.length > 6) log.shift();
  render();
}

// This is a terminal TUI shell (per SKILL.md/LOGIC.md — its whole job is to print the
// frame), so it writes directly to stdout rather than through console.*, which the
// repo's biome.json bans repo-wide outside `**/scripts/**` (suspicious/noConsole).
function print(line: string) {
  process.stdout.write(`${line}\n`);
}

function render() {
  process.stdout.write("\x1b[2J\x1b[H"); // clear + home
  print("\x1b[1mLong-press -> edit-mode prototype\x1b[0m (issue #71 mechanics check)\n");
  print(`\x1b[1mclock\x1b[0m: \x1b[2m${clockMs}ms\x1b[0m`);
  print(`\x1b[1mstate\x1b[0m: ${JSON.stringify(state)}`);
  print(
    `\x1b[1mthresholds\x1b[0m: \x1b[2mhold=${LONG_PRESS_THRESHOLD_MS}ms move-cancel=${MOVE_CANCEL_THRESHOLD_PX}px\x1b[0m`,
  );
  print(`\x1b[1meditMode flips so far\x1b[0m: ${editModeFlips}`);
  print(`\n\x1b[1mlast events\x1b[0m:`);
  for (const line of log) print(`  \x1b[2m${line}\x1b[0m`);
  print(
    "\n\x1b[1m[d]\x1b[0m down  \x1b[1m[m]\x1b[0m move-small  \x1b[1m[M]\x1b[0m move-big  " +
      "\x1b[1m[u]\x1b[0m up  \x1b[1m[t]\x1b[0m tick+100ms  \x1b[1m[r]\x1b[0m reset  \x1b[1m[q]\x1b[0m quit",
  );
}

render();

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (key: string) => {
  switch (key) {
    case "d":
      dispatch({ type: "pointerDown", nowMs: clockMs });
      break;
    case "m":
      dispatch({ type: "pointerMove", distancePx: 2 });
      break;
    case "M":
      dispatch({ type: "pointerMove", distancePx: 12 });
      break;
    case "u":
      dispatch({ type: "pointerUp", nowMs: clockMs });
      break;
    case "t":
      clockMs += 100;
      dispatch({ type: "tick", nowMs: clockMs });
      break;
    case "r":
      clockMs = 0;
      editModeFlips = 0;
      log.length = 0;
      state = initialLongPressState();
      render();
      break;
    case "q":
    case "": // ctrl-c
      process.stdin.setRawMode?.(false);
      process.exit(0);
      break;
  }
});
