import { describe, expect, test, vi } from "vitest";
import { createWorkerLifecycle } from "./lifecycle";

describe("createWorkerLifecycle", () => {
  test("requests shutdown once and closes both Temporal connections after the worker stops", async () => {
    const shutdown = vi.fn();
    const closeClient = vi.fn(async () => undefined);
    const closeNative = vi.fn(async () => undefined);
    const lifecycle = createWorkerLifecycle({
      worker: { run: vi.fn(async () => undefined), shutdown },
      closeClient,
      closeNative,
      logger: { info: vi.fn() },
    });

    lifecycle.shutdown("SIGTERM");
    lifecycle.shutdown("SIGINT");
    await lifecycle.run();

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(closeClient).toHaveBeenCalledOnce();
    expect(closeNative).toHaveBeenCalledOnce();
  });

  test("closes both Temporal connections when the worker fails", async () => {
    const closeClient = vi.fn(async () => undefined);
    const closeNative = vi.fn(async () => undefined);
    const lifecycle = createWorkerLifecycle({
      worker: {
        run: vi.fn(async () => {
          throw new Error("worker failed");
        }),
        shutdown: vi.fn(),
      },
      closeClient,
      closeNative,
      logger: { info: vi.fn() },
    });

    await expect(lifecycle.run()).rejects.toThrow("worker failed");
    expect(closeClient).toHaveBeenCalledOnce();
    expect(closeNative).toHaveBeenCalledOnce();
  });
});
