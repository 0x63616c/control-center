/**
 * Field builders for the central env registry (`@www/platform/env`).
 *
 * Each builder is a thin, chainable wrapper over a Zod parser that also carries
 * registry metadata (requiredness, owning runtime(s)/feature, secret flag,
 * defaults). A builder IS its own `FieldSpec`: the registry reads its metadata
 * and calls `resolve()` on first access. Nothing is parsed at construction —
 * parsing is deferred to first access so hydration order can never freeze a
 * pre-hydration default (design spec §3, goal 3).
 *
 * Static-type contract (design spec §4):
 * - `.optional()` widens the field's static type to `T | undefined`.
 * - `.optionalSecret()` keeps the static type `T` (string) but resolves to
 *   `undefined` at runtime when unset — an honest replacement for the old
 *   `.default("")`, gate-guarded by each feature's `isConfigured()` check, so no
 *   consumer needs re-typing.
 */
import { z } from "zod";

export type Runtime = "api" | "worker" | "web" | "cron" | "all";

/** Raw parser: turns a present (non-empty) env string into the typed value. */
type RawParse = (raw: string) => unknown;

/**
 * A single env-key declaration. The generic `TOut` is a phantom carrier for the
 * key's static output type (covariant — appears only in an optional output
 * position) so `defineEnv` can infer the registry's shape. All state is public,
 * read by `registry.ts` / `assert.ts` within the same package.
 */
export class FieldBuilder<TOut> {
  /** Phantom: carries the static output type for inference. Never assigned. */
  readonly _out?: TOut;

  _required = false;
  _optional = false;
  _optionalSecret = false;
  _hasDefault = false;
  _default: unknown;
  _devDefault: unknown;
  _hasDevDefault = false;
  _runtimes: Runtime[] = ["all"];
  _feature: string | undefined;
  readonly _secret: boolean;
  private readonly _parse: RawParse;

  constructor(parse: RawParse, secret = false) {
    this._parse = parse;
    this._secret = secret;
  }

  /** Must be present in prod; `assertEnv` crashes if missing. No prod default. */
  required(): this {
    this._required = true;
    return this;
  }

  /** Safe, public default applied in every environment when the key is absent. */
  default(value: TOut): this {
    this._hasDefault = true;
    this._default = value;
    return this;
  }

  /** Fallback used ONLY when `APP_ENV !== "production"`; still prod-required. */
  devDefault(value: TOut): this {
    this._hasDevDefault = true;
    this._devDefault = value;
    return this;
  }

  /** May be absent anywhere → resolves to `undefined` (widens static type). */
  optional(): FieldBuilder<TOut | undefined> {
    this._optional = true;
    return this as FieldBuilder<TOut | undefined>;
  }

  /**
   * A secret with no default: resolves to `undefined` at runtime when unset, but
   * keeps its static type (`string`) so gate-guarded consumers still typecheck
   * (design spec §4 static-type decision).
   */
  optionalSecret(): this {
    this._optionalSecret = true;
    return this;
  }

  /** Tag the owning runtime(s). Default `["all"]`. Used by `assertEnv`. */
  forRuntime(...runtimes: Runtime[]): this {
    this._runtimes = runtimes.length ? runtimes : ["all"];
    return this;
  }

  /** Tag the owning feature id (documentation + query grouping). */
  forFeature(id: string): this {
    this._feature = id;
    return this;
  }

  /**
   * Validate/parse a present raw value. Throws on malformed input (feeds the
   * `assertEnv` parse check and the first-access read). Callers must only pass a
   * present, non-empty string (empty/absent is handled by `resolve`).
   */
  parse(raw: string): unknown {
    return this._parse(raw);
  }

  /**
   * Resolve the key's value from a (possibly absent) raw env string, applying
   * default / devDefault / optional / required rules. Empty string is treated as
   * absent (a mounted-but-empty secret must not count as present).
   */
  resolve(raw: string | undefined): unknown {
    const present = raw !== undefined && raw !== "";
    if (present) return this._parse(raw);

    if (this._hasDefault) return this._default;
    const isProd = process.env.APP_ENV === "production";
    if (this._hasDevDefault && !isProd) return this._devDefault;
    // optional / optionalSecret / required-missing all resolve to undefined.
    // (A required key missing in prod is crashed loudly by assertEnv before any
    // access; this undefined is only reachable in dev/test.)
    return undefined;
  }
}

const urlParser = z.string().url();

/** Plain string. */
export function str(): FieldBuilder<string> {
  return new FieldBuilder<string>((raw) => raw);
}

/** String validated as a URL. */
export function url(): FieldBuilder<string> {
  return new FieldBuilder<string>((raw) => urlParser.parse(raw));
}

/** String validated as a postgres connection URL. */
export function pgUrl(): FieldBuilder<string> {
  return new FieldBuilder<string>((raw) => {
    const parsed = urlParser.parse(raw);
    if (!/^postgres(ql)?:\/\//.test(parsed)) {
      throw new Error(`expected a postgres URL, got: ${parsed.slice(0, 12)}…`);
    }
    return parsed;
  });
}

/** Number (coerced from string). */
export function num(): FieldBuilder<number> {
  const p = z.coerce.number();
  return new FieldBuilder<number>((raw) => p.parse(raw));
}

/** Integer (coerced from string). */
export function int(): FieldBuilder<number> {
  const p = z.coerce.number().int();
  return new FieldBuilder<number>((raw) => p.parse(raw));
}

/** Boolean: "true" or "1" → true, everything else → false. */
export function bool(): FieldBuilder<boolean> {
  return new FieldBuilder<boolean>((raw) => raw === "true" || raw === "1");
}

/** String flagged as a secret (never logged; feeds the redaction audit). */
export function secret(): FieldBuilder<string> {
  return new FieldBuilder<string>((raw) => raw, true);
}

/** One of a fixed set of string literals. */
export function enumOf<const T extends readonly [string, ...string[]]>(
  ...values: T
): FieldBuilder<T[number]> {
  return new FieldBuilder<T[number]>((raw) => {
    if (!values.includes(raw)) {
      throw new Error(`expected one of ${values.join("|")}, got: ${raw}`);
    }
    return raw as T[number];
  });
}
