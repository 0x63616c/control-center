// Tests for logChange: the primitive that lets a 1s reconcile loop log its
// decisions at `info` without flooding. See docs/logging.md §3.
import pino, { type DestinationStream } from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import { type Logger, logChange, resetChangeLog } from "../src/index.ts";

// Collect emitted lines instead of writing them to stdout.
function capturingLogger(): { log: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const stream: DestinationStream = {
    write(chunk: string) {
      lines.push(JSON.parse(chunk));
    },
  };
  return { log: pino({ level: "info" }, stream), lines };
}

beforeEach(() => {
  resetChangeLog();
});

describe("logChange", () => {
  it("emits the first call", () => {
    const { log, lines } = capturingLogger();
    logChange(log, "light-push:light.desk", { on: true }, "pushing");
    expect(lines).toHaveLength(1);
    expect(lines[0].msg).toBe("pushing");
    expect(lines[0].on).toBe(true);
  });

  it("suppresses identical repeats , the 1s-loop flood case", () => {
    const { log, lines } = capturingLogger();
    for (let i = 0; i < 3_600; i++) {
      logChange(log, "light-push:light.desk", { on: true, brightness: 200 }, "pushing");
    }
    expect(lines).toHaveLength(1);
  });

  it("emits again when the content changes", () => {
    const { log, lines } = capturingLogger();
    logChange(log, "light-push:light.desk", { brightness: 200 }, "pushing");
    logChange(log, "light-push:light.desk", { brightness: 120 }, "pushing");
    expect(lines).toHaveLength(2);
    expect(lines[1].brightness).toBe(120);
  });

  it("reports how many identical cycles were suppressed", () => {
    const { log, lines } = capturingLogger();
    logChange(log, "k", { on: true }, "pushing");
    for (let i = 0; i < 10; i++) logChange(log, "k", { on: true }, "pushing");
    // Force the re-announce by making the suppression window zero-length.
    logChange(log, "k", { on: true }, "pushing", { repeatAfterMs: 0 });
    expect(lines).toHaveLength(2);
    expect(lines[1].repeats).toBe(10);
  });

  it("keys are independent , one entity's churn cannot mute another's", () => {
    const { log, lines } = capturingLogger();
    logChange(log, "light-push:a", { on: true }, "pushing");
    logChange(log, "light-push:b", { on: true }, "pushing");
    expect(lines).toHaveLength(2);
  });

  it("re-announces an unchanged state once the repeat window elapses", () => {
    const { log, lines } = capturingLogger();
    logChange(log, "k", { on: true }, "pushing", { repeatAfterMs: 0 });
    logChange(log, "k", { on: true }, "pushing", { repeatAfterMs: 0 });
    expect(lines).toHaveLength(2);
  });

  it("resetChangeLog(key) makes the next call emit again", () => {
    const { log, lines } = capturingLogger();
    logChange(log, "k", { on: true }, "pushing");
    logChange(log, "k", { on: true }, "pushing");
    expect(lines).toHaveLength(1);
    resetChangeLog("k");
    logChange(log, "k", { on: true }, "pushing");
    expect(lines).toHaveLength(2);
  });
});

describe("Logger type", () => {
  it("has no debug/trace methods , our code never logs below info", () => {
    const { log } = capturingLogger();
    // @ts-expect-error debug is deliberately absent from the exported Logger
    // type: every line WE write is info or above, so it is visible at the prod
    // default without unmuting third-party pino chatter. docs/logging.md §3.
    const _debug = log.debug;
    // @ts-expect-error trace is absent for the same reason.
    const _trace = log.trace;
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
  });
});
