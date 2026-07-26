// Tests for installFatalHandlers: the process-wide uncaughtException /
// unhandledRejection safety net (see docs/logging.md §6-adjacent handler
// section). We deliberately do NOT trigger a real process-level
// uncaughtException/unhandledRejection from inside this Vitest process , Node
// calls every registered listener for these events (including Vitest's own
// instrumentation/reporter), so doing so risks the test file being marked
// failed regardless of our own assertions, and this repo has no existing
// precedent for that pattern. Instead we mirror packages/platform/test/env.test.ts's
// process.exit-spy precedent: spy on `process.on` to capture the two
// registered callbacks, then invoke each callback DIRECTLY with a synthetic
// error, with `process.exit` spied to throw so the test process never exits.
import pino, { type DestinationStream } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFatalHandlers, type Logger } from "../src/index.ts";

function capturingLogger(): { log: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const stream: DestinationStream = {
    write(chunk: string) {
      lines.push(JSON.parse(chunk));
    },
  };
  return { log: pino({ level: "info" }, stream) as unknown as Logger, lines };
}

// Capture the callback registered for a given event name via a spied
// process.on, without ever letting a real process-level event fire.
function captureHandler(
  onSpy: { mock: { calls: unknown[][] } },
  event: string,
): (arg: unknown) => void {
  const call = onSpy.mock.calls.find((args) => args[0] === event);
  if (!call) throw new Error(`no handler registered for "${event}"`);
  return call[1] as (arg: unknown) => void;
}

describe("installFatalHandlers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers exactly one uncaughtException and one unhandledRejection listener", () => {
    const onSpy = vi.spyOn(process, "on");
    const { log } = capturingLogger();
    installFatalHandlers(log);

    const registered = onSpy.mock.calls.map((args) => args[0]);
    expect(registered.filter((e) => e === "uncaughtException")).toHaveLength(1);
    expect(registered.filter((e) => e === "unhandledRejection")).toHaveLength(1);
  });

  it("logs a fatal line and exits(1) on uncaughtException", () => {
    const onSpy = vi.spyOn(process, "on");
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const { log, lines } = capturingLogger();
    installFatalHandlers(log);

    const handler = captureHandler(onSpy, "uncaughtException");
    const err = new Error("boom");
    expect(() => handler(err)).toThrow("exit:1");

    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe(60); // pino fatal level
    expect(lines[0].msg).toBe("uncaught exception");
    expect((lines[0].err as { message: string }).message).toBe("boom");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("logs a fatal line and exits(1) on unhandledRejection with a real Error reason", () => {
    const onSpy = vi.spyOn(process, "on");
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const { log, lines } = capturingLogger();
    installFatalHandlers(log);

    const handler = captureHandler(onSpy, "unhandledRejection");
    const err = new Error("rejected");
    expect(() => handler(err)).toThrow("exit:1");

    expect(lines).toHaveLength(1);
    expect(lines[0].msg).toBe("unhandled rejection");
    expect((lines[0].err as { message: string }).message).toBe("rejected");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("normalizes a non-Error unhandledRejection reason so message/stack still render", () => {
    const onSpy = vi.spyOn(process, "on");
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const { log, lines } = capturingLogger();
    installFatalHandlers(log);

    const handler = captureHandler(onSpy, "unhandledRejection");
    expect(() => handler("string rejection reason")).toThrow("exit:1");

    expect(lines).toHaveLength(1);
    const loggedErr = lines[0].err as { message: string; stack?: string };
    expect(loggedErr.message).toBe("string rejection reason");
    expect(typeof loggedErr.stack).toBe("string");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
