import { describe, expect, it } from "vitest";
import {
  alertsSignature,
  alertToRaise,
  CONNECTION_ALERT_ID,
  outageAlert,
} from "../notification-bridge";

describe("alertToRaise", () => {
  it("ignores the device-name banner , ticket #63 dropped its notification-center entry", () => {
    expect(alertToRaise({ id: "device-name", message: "Please set your device name" })).toBeNull();
  });

  it("carries the banner detail through as the body", () => {
    const payload = alertToRaise({
      id: "app-update",
      message: "Update available",
      detail: "2 builds behind",
    });
    expect(payload?.severity).toBe("info");
    expect(payload?.body).toBe("2 builds behind");
  });

  it("keys on the message so changed copy records a genuinely new row", () => {
    const a = alertToRaise({ id: "app-update", message: "2 builds behind" });
    const b = alertToRaise({ id: "app-update", message: "3 builds behind" });
    expect(a?.dedupeKey).not.toBe(b?.dedupeKey);
  });

  it("keys identically for a remount with the same copy", () => {
    const a = alertToRaise({ id: "app-update", message: "2 builds behind" });
    const b = alertToRaise({ id: "app-update", message: "2 builds behind" });
    expect(a?.dedupeKey).toBe(b?.dedupeKey);
  });

  it("REFUSES the connection alert , it cannot be raised while the API is down", () => {
    expect(alertToRaise({ id: CONNECTION_ALERT_ID, message: "Unable to connect…" })).toBeNull();
  });

  it("maps the not-charging banner to a system critical", () => {
    const payload = alertToRaise({
      id: "battery-not-charging",
      message: "iPad is not charging",
      detail: "Running on battery. Check the dock cable and power adapter.",
    });
    expect(payload?.category).toBe("system");
    expect(payload?.severity).toBe("critical");
  });

  // iOS renders an APNs title on one truncated line, so the headline this
  // bridge promotes to `title` has to stay short and the explanation has to
  // land in `body`. A regression here shows up as "iPad is not connect…".
  it("keeps the not-charging title short and puts the explanation in the body", () => {
    const payload = alertToRaise({
      id: "battery-not-charging",
      message: "Kitchen Panel is not charging",
      detail: "Running on battery. Check the dock cable and power adapter.",
    });
    expect(payload?.title.length).toBeLessThanOrEqual(38);
    expect(payload?.body).toContain("dock cable");
  });

  it("ignores an unknown banner id rather than inventing a category", () => {
    expect(alertToRaise({ id: "something-new", message: "hi" })).toBeNull();
  });
});

describe("outageAlert", () => {
  const start = Date.parse("2026-07-18T12:00:00.000Z");

  it("keys on the outage start so one outage yields one row", () => {
    const a = outageAlert(start, start + 30_000);
    const b = outageAlert(start, start + 90_000);
    expect(a.dedupeKey).toBe(b.dedupeKey);
    expect(a.dedupeKey).toBe(`${CONNECTION_ALERT_ID}:${start}`);
  });

  it("distinguishes two separate outages", () => {
    expect(outageAlert(start, start + 1000).dedupeKey).not.toBe(
      outageAlert(start + 60_000, start + 61_000).dedupeKey,
    );
  });

  it("reports a sub-minute outage in seconds", () => {
    expect(outageAlert(start, start + 42_000).body).toContain("42s");
  });

  it("reports a longer outage in minutes and seconds", () => {
    expect(outageAlert(start, start + 125_000).body).toContain("2m 05s");
  });

  it("never reports a zero-length outage", () => {
    expect(outageAlert(start, start).body).toContain("1s");
  });

  it("is a warning about recovery, not a live critical alert", () => {
    const payload = outageAlert(start, start + 5000);
    expect(payload.severity).toBe("warning");
    expect(payload.category).toBe("system");
    expect(payload.body).toContain("recovered");
  });
});

describe("alertsSignature", () => {
  it("is stable across equal lists so the bridge effect doesn't re-run", () => {
    const a = [{ id: "x", message: "m", detail: "d" }];
    const b = [{ id: "x", message: "m", detail: "d" }];
    expect(alertsSignature(a)).toBe(alertsSignature(b));
  });

  it("changes when a message changes", () => {
    expect(alertsSignature([{ id: "x", message: "one" }])).not.toBe(
      alertsSignature([{ id: "x", message: "two" }]),
    );
  });

  it("changes when an alert clears", () => {
    expect(alertsSignature([{ id: "x", message: "m" }])).not.toBe(alertsSignature([]));
  });
});
