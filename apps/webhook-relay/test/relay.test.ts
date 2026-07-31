import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createRelay } from "../src/relay";

const secret = "test-secret";
const body = new Uint8Array([0, 255, 1, 2, 10]);
const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const headers = {
  "x-hub-signature-256": signature,
  "x-github-delivery": "delivery_1",
  "x-github-event": "push",
  "x-github-hook-id": "hook_1",
  "content-type": "application/json",
  "x-ignore": "no",
};
const request = (extra: Record<string, string> = {}) =>
  new Request("http://relay/github", { method: "POST", headers: { ...headers, ...extra }, body });
const legacyRequest = () =>
  new Request("http://relay/hooks/github", { method: "POST", headers, body });

describe("webhook relay", () => {
  it("keeps the existing public /hooks/github delivery path", async () => {
    const fetch = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(
      async () => new Response(null, { status: 204 }),
    );
    const relay = createRelay({
      secret,
      targets: [{ name: "control-center", url: "http://control-center" }],
      fetch,
      sleep: async () => {},
    });
    expect((await relay(legacyRequest())).status).toBe(204);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });
  it("returns 204 and forwards the exact bytes and trusted headers to every configured target", async () => {
    const fetch = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(
      async () => new Response(null, { status: 204 }),
    );
    const relay = createRelay({
      secret,
      targets: [
        { name: "one", url: "http://one" },
        { name: "two", url: "http://two" },
      ],
      fetch,
      sleep: async () => {},
    });
    expect((await relay(request())).status).toBe(204);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    for (const call of fetch.mock.calls) {
      expect([...new Uint8Array((await (call[1] as RequestInit).body) as ArrayBuffer)]).toEqual([
        ...body,
      ]);
      const sent = new Headers((call[1] as RequestInit).headers);
      for (const [key, value] of Object.entries(headers).filter(([key]) => key !== "x-ignore"))
        expect(sent.get(key)).toBe(value);
      expect(sent.get("x-ignore")).toBeNull();
    }
  });
  it("rejects invalid signatures without forwarding", async () => {
    const fetch = vi.fn();
    const relay = createRelay({
      secret,
      targets: [{ name: "one", url: "http://one" }],
      fetch,
      sleep: async () => {},
    });
    expect((await relay(request({ "x-hub-signature-256": "sha256=nope" }))).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("isolates targets and retries 5xx three times but not 4xx", async () => {
    const fetch = vi.fn(
      async (url: string) => new Response(null, { status: url.includes("bad") ? 500 : 204 }),
    );
    const relay = createRelay({
      secret,
      targets: [
        { name: "bad", url: "http://bad" },
        { name: "good", url: "http://good" },
      ],
      fetch,
      sleep: async () => {},
    });
    await relay(request());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    expect(fetch.mock.calls.filter(([url]) => url === "http://good")).toHaveLength(1);
    const fourOhFour = vi.fn(async () => new Response(null, { status: 400 }));
    await createRelay({
      secret,
      targets: [{ name: "reject", url: "http://reject" }],
      fetch: fourOhFour,
      sleep: async () => {},
    })(request());
    await vi.waitFor(() => expect(fourOhFour).toHaveBeenCalledTimes(1));
  });
  it("does not wait for a slow target before responding", async () => {
    const relay = createRelay({
      secret,
      targets: [{ name: "slow", url: "http://slow" }],
      fetch: () => new Promise<Response>(() => {}),
      sleep: async () => {},
    });
    await expect(relay(request())).resolves.toMatchObject({ status: 204 });
  });
});
