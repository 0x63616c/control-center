/**
 * Withings-specific error class. Thrown on network failure, non-2xx HTTP, or
 * an in-body Withings `status !== 0` (Withings always returns HTTP 200; errors
 * are signalled in the JSON body, not the status code).
 */
export class WithingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WithingsError";
  }
}
