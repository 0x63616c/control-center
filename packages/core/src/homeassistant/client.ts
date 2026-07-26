import { getLogger } from "@www/logger";
import { z } from "zod";

const HA_REQUEST_TIMEOUT_MS = 5_000;

// Edge schema for an HA `/api/states` entity. The client parses responses with
// this so domain code consumes validated entities. `attributes` is an open bag
// (fan_modes, brightness, friendly_name, …) kept fully as unknown; the entity
// object stays loose so HA's extra top-level fields (context, last_reported, …)
// pass through untouched.
const haEntitySchema = z.looseObject({
  entity_id: z.string(),
  state: z.string(),
  attributes: z.record(z.string(), z.unknown()).default({}),
  last_updated: z.string(),
  last_changed: z.string().optional(),
});

export type HaEntity = z.infer<typeof haEntitySchema>;

export class HaError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "HaError";
  }
}

export interface HomeAssistantClientOptions {
  baseUrl: string;
  token: string;
}

/**
 * Typed REST client for Home Assistant.
 *
 * Env-free: callers (apps/api's singleton, features building their own instance,
 * tests) provide `{ baseUrl, token }` explicitly. Construct via
 * `createHomeAssistantClient`. Every request carries a 5s timeout and the bearer
 * `token`. When the token is empty (`isConfigured()` is false) the api still
 * boots; callers should check `isConfigured()` and degrade to placeholder data
 * rather than firing requests that will 401.
 */
export class HomeAssistantClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(opts: HomeAssistantClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.token = opts.token;
  }

  /** True only when a token is present. */
  isConfigured(): boolean {
    return this.token.length > 0;
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Single request choke point for every HA call. Owns the timeout, the network
   * vs non-2xx error mapping to `HaError`, and the `warn` telemetry, then returns
   * the raw `Response` so callers pick the body shape (json / text / binary).
   *
   * `init` must carry its own headers (auth differs per caller); `logPath`
   * overrides what is logged as `haPath` (used to strip an access token from a
   * media path before it reaches the logs).
   */
  private async haFetch(
    path: string,
    init: RequestInit,
    logPath: string = path,
  ): Promise<Response> {
    const startedAt = performance.now();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(HA_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const durationMs = +(performance.now() - startedAt).toFixed(1);
      // status 0 = network-level failure (timeout, DNS, refused)
      getLogger().warn({ haPath: logPath, haStatus: 0, durationMs }, "ha request failed");
      throw new HaError(0, `Network error: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const durationMs = +(performance.now() - startedAt).toFixed(1);
      getLogger().warn({ haPath: logPath, haStatus: res.status, durationMs }, "ha request non-2xx");
      throw new HaError(res.status, await res.text());
    }
    return res;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.haFetch(path, {
      ...init,
      headers: { ...this.authHeaders(), ...(init?.headers ?? {}) },
    });
    return res.json() as Promise<T>;
  }

  /** All entities in a domain (e.g. "light", "climate"). */
  async getEntities(domain: string): Promise<HaEntity[]> {
    const all = z.array(haEntitySchema).parse(await this.request<unknown>("/api/states"));
    return all.filter((e) => e.entity_id.startsWith(`${domain}.`));
  }

  /** A single entity by id (e.g. "light.living_room"). */
  async getEntity(entityId: string): Promise<HaEntity> {
    return haEntitySchema.parse(await this.request<unknown>(`/api/states/${entityId}`));
  }

  /** Call a service (e.g. callService("light", "turn_on", { entity_id })). */
  async callService(
    domain: string,
    service: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    await this.request(`/api/services/${domain}/${service}`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  /** Render a Jinja2 template against HA state; returns the rendered string. */
  async renderTemplate(template: string): Promise<string> {
    const res = await this.haFetch("/api/template", {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ template }),
    });
    return res.text();
  }

  /** Authenticated camera snapshot proxy URL for an entity. */
  cameraProxyUrl(entityId: string): string {
    return `${this.baseUrl}/api/camera_proxy/${entityId}`;
  }

  /**
   * Raw authenticated GET for binary HA resources (entity_picture artwork).
   * Returns the Response so callers can stream body + content-type through.
   */
  async getMedia(path: string): Promise<Response> {
    // entity_picture paths embed an HA access token in the query string ,
    // log only the bare path so the token never reaches the logs.
    const logPath = path.split("?")[0] ?? path;
    return this.haFetch(path, { headers: { Authorization: `Bearer ${this.token}` } }, logPath);
  }
}

/** Construct a `HomeAssistantClient` from mandatory, explicit config (no env access). */
export function createHomeAssistantClient(opts: HomeAssistantClientOptions): HomeAssistantClient {
  return new HomeAssistantClient(opts);
}

/**
 * Bind a `HomeAssistantClient` to a feature's own config slice. Every caller
 * (ac/ctrl/tv/dogcam features, apps/api's singleton) was writing the identical
 * `createHomeAssistantClient({ baseUrl: config.HA_URL, token: config.HA_TOKEN })`
 * expression against its own `ENV.pick(...)` projection; this collapses that to
 * one call while keeping each caller's config slice genuinely separate (the
 * client stays env-free, this just names the binding). Accepts any object with
 * the two fields rather than the full `ENV` type, since every caller's slice is
 * a narrower projection.
 */
export function haFromConfig(config: { HA_URL: string; HA_TOKEN: string }): HomeAssistantClient {
  return createHomeAssistantClient({ baseUrl: config.HA_URL, token: config.HA_TOKEN });
}
