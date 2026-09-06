import {
  type RateLimitClass,
  rateLimitClasses,
} from "../../../../../apps/dont-text-your-ex/contracts/rate-limit-policy";

export type RateLimitResult = Readonly<{ success: boolean }>;

export type RateLimitBinding = {
  limit(input: Readonly<{ key: string }>): Promise<RateLimitResult>;
};

export type EdgeEnv = {
  GENERAL_RATE_LIMITER: RateLimitBinding;
  AUTH_RATE_LIMITER: RateLimitBinding;
  INVITE_RATE_LIMITER: RateLimitBinding;
  REPORT_EVIDENCE_RATE_LIMITER: RateLimitBinding;
  MUTATION_RATE_LIMITER: RateLimitBinding;
};

type OriginFetch = (request: Request) => Promise<Response>;

const RETRY_AFTER_SECONDS = 60;

function bindingFor(env: EdgeEnv, routeClass: RateLimitClass): RateLimitBinding {
  switch (routeClass) {
    case "general":
      return env.GENERAL_RATE_LIMITER;
    case "auth":
      return env.AUTH_RATE_LIMITER;
    case "invite":
      return env.INVITE_RATE_LIMITER;
    case "reportEvidence":
      return env.REPORT_EVIDENCE_RATE_LIMITER;
    case "mutation":
      return env.MUTATION_RATE_LIMITER;
  }
}

function isCloudflareClientAddress(value: string): boolean {
  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > 45 || /[^0-9a-fA-F:.]/.test(candidate)) {
    return false;
  }
  if (candidate.includes(":")) return candidate.split(":").length >= 3;
  const octets = candidate.split(".");
  return (
    octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

async function opaqueKey(clientAddress: string, routeClass: RateLimitClass): Promise<string> {
  const encoded = new TextEncoder().encode(`${routeClass}\0${clientAddress}`);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function jsonResponse(body: unknown, status: number, marker: string): Response {
  return Response.json(body, {
    status,
    headers: {
      "Retry-After": String(RETRY_AFTER_SECONDS),
      "X-DTYE-Rate-Limit-Layer": marker,
    },
  });
}

function denied(routeClass: RateLimitClass): Response {
  if (routeClass === "invite") {
    return jsonResponse(
      { error: "invite_rate_limited", retryAfterSeconds: RETRY_AFTER_SECONDS },
      429,
      "edge",
    );
  }
  return jsonResponse(
    { error: "rate_limited", routeClass, retryAfterSeconds: RETRY_AFTER_SECONDS },
    429,
    "edge",
  );
}

function unavailable(): Response {
  return jsonResponse({ error: "edge_rate_limit_unavailable" }, 503, "edge-error");
}

export async function handleRequest(
  request: Request,
  env: EdgeEnv,
  originFetch: OriginFetch = fetch,
): Promise<Response> {
  const clientAddress = request.headers.get("CF-Connecting-IP") ?? "";
  if (!isCloudflareClientAddress(clientAddress)) return unavailable();

  const { pathname } = new URL(request.url);
  const routeClasses = rateLimitClasses(request.method, pathname);
  try {
    for (const routeClass of routeClasses) {
      const result = await bindingFor(env, routeClass).limit({
        key: await opaqueKey(clientAddress, routeClass),
      });
      if (!result.success) return denied(routeClass);
    }
  } catch {
    return unavailable();
  }
  return originFetch(request);
}

export default {
  fetch(
    request: Request,
    env: EdgeEnv,
    _context: unknown,
    originFetch: OriginFetch = fetch,
  ): Promise<Response> {
    return handleRequest(request, env, originFetch);
  },
};
