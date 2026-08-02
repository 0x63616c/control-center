import { describe, expect, it, vi } from "vitest";
import { enqueueNotification } from "./notifications";

describe("enqueueNotification", () => {
  it("publishes the neutral intent through the durable queue", async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 17 }]);
    const values = vi.fn(() => ({ returning }));
    const insert = vi.fn(() => ({ values }));
    const db = { insert };
    const input = {
      category: "home" as const,
      severity: "info" as const,
      title: "New weight logged",
      dedupeKey: "weight-42",
    };

    await expect(enqueueNotification(db as never, input)).resolves.toBe(17);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "raise_notification",
        payload: input,
      }),
    );
  });
});
