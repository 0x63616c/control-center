import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { MAX_BODY_BYTES, toDeliveryRow, verifySignature } from "./service";

const SECRET = "test-webhook-secret";
const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(Buffer.from(body)).digest("hex")}`;
const bytes = (s: string) => new Uint8Array(Buffer.from(s));

describe("verifySignature", () => {
  test("accepts a signature over the exact raw bytes", () => {
    const body = '{"action":"opened"}';
    expect(verifySignature(bytes(body), sign(body), SECRET)).toBeNull();
  });

  test("rejects a body signed with a different secret", () => {
    const body = '{"action":"opened"}';
    expect(verifySignature(bytes(body), sign(body, "wrong-secret"), SECRET)).toBe("bad-signature");
  });

  test("rejects when the body is altered after signing", () => {
    const signature = sign('{"action":"opened"}');
    expect(verifySignature(bytes('{"action":"closed"}'), signature, SECRET)).toBe("bad-signature");
  });

  // The signature is over raw bytes, so a re-serialised payload — same data,
  // different key order/whitespace — must NOT validate. This is the mistake the
  // handler's "raw bytes" contract exists to prevent.
  test("rejects a re-serialised body with identical data", () => {
    const original = '{"action":"opened","number":7}';
    const reserialised = JSON.stringify(JSON.parse(original), null, 2);
    expect(verifySignature(bytes(reserialised), sign(original), SECRET)).toBe("bad-signature");
  });

  test("rejects a missing signature header", () => {
    expect(verifySignature(bytes("{}"), null, SECRET)).toBe("missing-signature");
  });

  test("rejects a malformed signature without throwing on length mismatch", () => {
    expect(verifySignature(bytes("{}"), "sha256=deadbeef", SECRET)).toBe("bad-signature");
    expect(verifySignature(bytes("{}"), "", SECRET)).toBe("missing-signature");
  });

  test("rejects an oversized body before doing any HMAC work", () => {
    const huge = new Uint8Array(MAX_BODY_BYTES + 1);
    expect(verifySignature(huge, "sha256=whatever", SECRET)).toBe("body-too-large");
  });
});

describe("toDeliveryRow", () => {
  const headers = { deliveryId: "d-1", event: "issues", hookId: "h-1" };

  test("flattens an issues payload", () => {
    const row = toDeliveryRow(headers, {
      action: "opened",
      issue: { number: 42 },
      repository: { full_name: "0x63616c/world-wide-webb" },
      sender: { login: "0x63616c" },
      installation: { id: 149184348 },
    });

    expect(row).toMatchObject({
      deliveryId: "d-1",
      source: "github",
      event: "issues",
      action: "opened",
      repo: "0x63616c/world-wide-webb",
      senderLogin: "0x63616c",
      subjectType: "issue",
      subjectNumber: 42,
      // Stringified: GitHub ids are numbers on the wire but the column is text.
      installationId: "149184348",
      signatureValid: true,
    });
  });

  test("prefers pull_request over issue (PR payloads carry both)", () => {
    const row = toDeliveryRow(headers, { pull_request: { number: 9 }, issue: { number: 42 } });
    expect(row).toMatchObject({ subjectType: "pull_request", subjectNumber: 9 });
  });

  // Every subscribed event type goes through this; an unfamiliar shape must
  // degrade to nulls, never throw (a 500 makes GitHub disable the hook).
  test("degrades to nulls on an unfamiliar payload instead of throwing", () => {
    const row = toDeliveryRow({ deliveryId: "d-2", event: "meta", hookId: null }, {});
    expect(row).toMatchObject({
      event: "meta",
      action: null,
      repo: null,
      senderLogin: null,
      subjectType: null,
      subjectNumber: null,
      installationId: null,
      hookId: null,
    });
  });

  test("returns null when the delivery id or event header is missing", () => {
    expect(toDeliveryRow({ deliveryId: null, event: "issues", hookId: null }, {})).toBeNull();
    expect(toDeliveryRow({ deliveryId: "d", event: null, hookId: null }, {})).toBeNull();
  });
});
