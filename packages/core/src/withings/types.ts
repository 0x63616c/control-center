/** Constructor credentials for WithingsClient. */
export interface WithingsCredentials {
  clientId: string;
  clientSecret: string;
}

/** Result of a token refresh. Caller owns persisting this , the client never does. */
export interface WithingsTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  withingsUserId: string;
}

/** meastype 1 (weight) plus whatever other meastypes rode the same group. */
export interface WithingsMeasureGroup {
  grpid: number;
  date: Date;
  weightKg: number | null;
  /** Other meastypes present in the group (fat_ratio, muscle_mass, ...), or null. */
  bodyMetrics: Record<string, number> | null;
}
