/**
 * Withings Cloud API client , direct polling (replaces HA's 10min-poll
 * integration for the weight-ingest cycle). Stateless w.r.t. token
 * persistence, throw-on-error, no fabricated data.
 */

export { createWithingsClient, WithingsClient } from "./client";
export { WithingsError } from "./errors";
export type { WithingsCredentials, WithingsMeasureGroup, WithingsTokenPair } from "./types";
