import { describe, expect, test } from "vitest";
import { LAN_SERVICE_IPS, METALLB_ADDRESS_POOL_RANGE } from "../src/metallb.ts";
import {
  composeGhcrDockerConfigJson,
  composeGo2rtcConfig,
  haTarget,
  parseSubstrate,
  parseSubstrateTarget,
  plexAdvertiseIp,
} from "../src/services.ts";

// The two pure string builders pulled out of deployServices (www-j934.6): the
// go2rtc config YAML and the GHCR imagePullSecret `.dockerconfigjson`. Both take
// plain inputs and return a deterministic string, so their credential encoding
// and exact wire shape are unit-testable without instantiating any Pulumi
// resource. deployServices just feeds vault values through these.

const VAULT = {
  EUFY_BEDROOM_CAM__HOST: "10.0.0.5",
  EUFY_BEDROOM_CAM__RTSP_USERNAME: "admin",
  EUFY_BEDROOM_CAM__RTSP_PASSWORD: "s3cret",
  EUFY_BEDROOM_CAM__RTSP_PATH: "live0",
} satisfies Record<string, string>;

const withVault = (overrides: Partial<typeof VAULT>): Record<string, string> => ({
  ...VAULT,
  ...overrides,
});

// The one URL line is where every credential/host/path edge case lands.
const rtspLineOf = (yaml: string): string => {
  const line = yaml.split("\n").find((l) => l.includes("rtsp://"));
  if (!line) throw new Error("no rtsp:// line in config");
  return line.trim().replace(/^-\s*/, "");
};

describe("composeGo2rtcConfig", () => {
  test("renders the exact YAML shape for a simple camera (pins current output)", () => {
    expect(composeGo2rtcConfig(VAULT)).toBe(
      [
        "api:",
        '  listen: ":1984"',
        "streams:",
        "  bedroom:",
        "    - rtsp://admin:s3cret@10.0.0.5:554/live0",
        "  bedroom_mjpeg:",
        "    - ffmpeg:bedroom#video=mjpeg#width=960",
        "log:",
        "  level: info",
        "",
      ].join("\n"),
    );
  });

  test("is deterministic: identical input yields byte-identical output", () => {
    expect(composeGo2rtcConfig(VAULT)).toBe(composeGo2rtcConfig({ ...VAULT }));
  });

  test("ends with a trailing newline (the file's final line is empty)", () => {
    expect(composeGo2rtcConfig(VAULT).endsWith("\n")).toBe(true);
  });

  describe("credential URL-encoding (a password can't break the URL authority)", () => {
    test.each([
      // [raw password, expected encoded form]
      ["p@ss", "p%40ss"],
      ["a:b", "a%3Ab"],
      ["a/b", "a%2Fb"],
      ["a#b", "a%23b"],
      ["a b", "a%20b"],
      ["a?b", "a%3Fb"],
      ["100%", "100%25"],
      ["p@:s/s#1 2", "p%40%3As%2Fs%231%202"],
    ])("password %j encodes to %j", (raw, encoded) => {
      const line = rtspLineOf(
        composeGo2rtcConfig(withVault({ EUFY_BEDROOM_CAM__RTSP_PASSWORD: raw })),
      );
      expect(line).toBe(`rtsp://admin:${encoded}@10.0.0.5:554/live0`);
    });

    test("username is URL-encoded the same way", () => {
      const line = rtspLineOf(
        composeGo2rtcConfig(withVault({ EUFY_BEDROOM_CAM__RTSP_USERNAME: "us@r:1" })),
      );
      expect(line).toBe("rtsp://us%40r%3A1:s3cret@10.0.0.5:554/live0");
    });
  });

  describe("path handling", () => {
    test("strips a single leading slash", () => {
      const line = rtspLineOf(
        composeGo2rtcConfig(withVault({ EUFY_BEDROOM_CAM__RTSP_PATH: "/live0" })),
      );
      expect(line).toBe("rtsp://admin:s3cret@10.0.0.5:554/live0");
    });

    test("strips repeated leading slashes", () => {
      const line = rtspLineOf(
        composeGo2rtcConfig(withVault({ EUFY_BEDROOM_CAM__RTSP_PATH: "///live0" })),
      );
      expect(line).toBe("rtsp://admin:s3cret@10.0.0.5:554/live0");
    });

    test("keeps interior slashes (only leading ones are stripped)", () => {
      const line = rtspLineOf(
        composeGo2rtcConfig(withVault({ EUFY_BEDROOM_CAM__RTSP_PATH: "/stream/main" })),
      );
      expect(line).toBe("rtsp://admin:s3cret@10.0.0.5:554/stream/main");
    });

    test("host is interpolated verbatim (not encoded)", () => {
      const line = rtspLineOf(
        composeGo2rtcConfig(withVault({ EUFY_BEDROOM_CAM__HOST: "cam.local" })),
      );
      expect(line).toBe("rtsp://admin:s3cret@cam.local:554/live0");
    });
  });

  describe("required-key validation", () => {
    test.each([
      "EUFY_BEDROOM_CAM__HOST",
      "EUFY_BEDROOM_CAM__RTSP_USERNAME",
      "EUFY_BEDROOM_CAM__RTSP_PASSWORD",
      "EUFY_BEDROOM_CAM__RTSP_PATH",
    ])("throws when %s is missing", (key) => {
      const vault = { ...VAULT };
      delete (vault as Record<string, string>)[key];
      expect(() => composeGo2rtcConfig(vault)).toThrow(`vault key ${key} not found`);
    });

    test("throws when a required key is present but empty", () => {
      expect(() => composeGo2rtcConfig(withVault({ EUFY_BEDROOM_CAM__RTSP_PASSWORD: "" }))).toThrow(
        /RTSP_PASSWORD not found/,
      );
    });
  });
});

describe("composeGhcrDockerConfigJson", () => {
  const decode = (json: string) =>
    JSON.parse(json) as {
      auths: Record<string, { username: string; password: string; auth: string }>;
    };

  test("emits a single ghcr.io auth entry with the org username and PAT", () => {
    const entry = decode(composeGhcrDockerConfigJson("ghp_token")).auths["ghcr.io"];
    expect(entry.username).toBe("0x63616c");
    expect(entry.password).toBe("ghp_token");
  });

  test("auth is base64('username:pat') for the registry Basic-auth header", () => {
    const entry = decode(composeGhcrDockerConfigJson("ghp_token")).auths["ghcr.io"];
    expect(entry.auth).toBe(Buffer.from("0x63616c:ghp_token").toString("base64"));
    expect(Buffer.from(entry.auth, "base64").toString()).toBe("0x63616c:ghp_token");
  });

  test("only ghcr.io is present (no other registries leak in)", () => {
    expect(Object.keys(decode(composeGhcrDockerConfigJson("t")).auths)).toEqual(["ghcr.io"]);
  });

  test("pins the exact wire shape for a known PAT", () => {
    expect(composeGhcrDockerConfigJson("ghp_token")).toBe(
      JSON.stringify({
        auths: {
          "ghcr.io": {
            username: "0x63616c",
            password: "ghp_token",
            auth: Buffer.from("0x63616c:ghp_token").toString("base64"),
          },
        },
      }),
    );
  });

  test("is deterministic: identical PAT yields byte-identical output", () => {
    expect(composeGhcrDockerConfigJson("ghp_token")).toBe(composeGhcrDockerConfigJson("ghp_token"));
  });
});

// The `substrate` flag (mini-migration Task 3): haTarget/plexAdvertiseIp must
// keep the mini's ("orbstack") values byte-identical to today's live deploy
// when the flag is absent, and switch to the node LAN IP on "talos".
describe("parseSubstrate", () => {
  test("undefined config defaults to orbstack (the mini)", () => {
    expect(parseSubstrate(undefined)).toBe("orbstack");
  });

  test("accepts the two known substrates verbatim", () => {
    expect(parseSubstrate("orbstack")).toBe("orbstack");
    expect(parseSubstrate("talos")).toBe("talos");
  });

  test("rejects an unknown substrate value", () => {
    expect(() => parseSubstrate("swarm")).toThrow(/wwwinfra:substrate/);
  });
});

describe("haTarget", () => {
  test("ha target is the node LAN IP on talos (api/worker are non-hostNetwork pods)", () => {
    expect(haTarget({ substrate: "talos", nodeIp: "192.168.0.5" })).toBe("192.168.0.5");
    expect(haTarget({ substrate: "orbstack" })).toBe("homelab.tail8c014d.ts.net");
  });
});

describe("plexAdvertiseIp", () => {
  // Nothing listens on :32400 in the node's netns - Plex is reached only
  // through its MetalLB LoadBalancer - so advertising the node IP hands every
  // client a refused connection.
  test("plex advertise uses the LoadBalancer address, not the node IP, on talos", () => {
    expect(plexAdvertiseIp({ substrate: "talos", nodeIp: "192.168.0.5" })).toBe(
      `http://${LAN_SERVICE_IPS.plex}:32400`,
    );
    expect(plexAdvertiseIp({ substrate: "talos", nodeIp: "192.168.0.5" })).not.toContain(
      "192.168.0.5",
    );
  });

  test("orbstack is the mini's frozen LAN IP", () => {
    expect(plexAdvertiseIp({ substrate: "orbstack" })).toBe("http://192.168.0.147:32400");
  });
});

// The pinned addresses and the pool they come from live in the same file, but
// nothing stops one being edited without the other; an out-of-pool pin leaves
// the Service permanently <pending>.
describe("LAN_SERVICE_IPS", () => {
  test("every pinned address falls inside the MetalLB pool range", () => {
    const [start, end] = METALLB_ADDRESS_POOL_RANGE.split("-");
    const asNumber = (ip: string) =>
      ip.split(".").reduce((acc, octet) => acc * 256 + Number(octet), 0);

    for (const ip of Object.values(LAN_SERVICE_IPS)) {
      expect(asNumber(ip)).toBeGreaterThanOrEqual(asNumber(start));
      expect(asNumber(ip)).toBeLessThanOrEqual(asNumber(end));
    }
  });

  test("no two services are pinned to the same address", () => {
    const addresses = Object.values(LAN_SERVICE_IPS);
    expect(new Set(addresses).size).toBe(addresses.length);
  });
});

// Task 4's deferred Task-3 cleanup: a talos SubstrateTarget always carries its
// nodeIp by construction (no `nodeIp?: string` default-"" footgun), so the
// only place a nodeIp is ever attached to a substrate is this boundary function.
describe("parseSubstrateTarget", () => {
  test("undefined config defaults to orbstack, with no nodeIp field at all", () => {
    expect(parseSubstrateTarget(undefined, undefined)).toEqual({ substrate: "orbstack" });
  });

  test("talos with an explicit nodeIp config value", () => {
    expect(parseSubstrateTarget("talos", "10.0.0.9")).toEqual({
      substrate: "talos",
      nodeIp: "10.0.0.9",
    });
  });

  test("talos with no nodeIp config falls back to the locked static IP", () => {
    expect(parseSubstrateTarget("talos", undefined)).toEqual({
      substrate: "talos",
      nodeIp: "192.168.0.5",
    });
  });

  test("talos with an empty-string nodeIp config also falls back (not a silent empty nodeIp)", () => {
    expect(parseSubstrateTarget("talos", "")).toEqual({
      substrate: "talos",
      nodeIp: "192.168.0.5",
    });
  });

  test("orbstack ignores any nodeIp value entirely (the field doesn't exist on this variant)", () => {
    expect(parseSubstrateTarget("orbstack", "10.0.0.9")).toEqual({ substrate: "orbstack" });
  });

  test("rejects an unknown substrate value (delegates to parseSubstrate)", () => {
    expect(() => parseSubstrateTarget("swarm", undefined)).toThrow(/wwwinfra:substrate/);
  });
});
