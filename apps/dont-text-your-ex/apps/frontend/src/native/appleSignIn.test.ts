import { describe, expect, it } from "vitest";
import {
  type AppleSignInResponse,
  createAppleSignInAttempt,
  validateAppleSignInResponse,
} from "./appleSignIn";

function response(overrides: Partial<AppleSignInResponse> = {}): AppleSignInResponse {
  return {
    identityToken: "signed.identity.token",
    hasAuthorizationCode: true,
    user: "apple-user-123",
    attemptId: "attempt_active",
    state: "state_active",
    ...overrides,
  };
}

describe("native Sign in with Apple request binding", () => {
  it("hashes the nonce sent to Apple while retaining the raw nonce for the API", async () => {
    const attempt = await createAppleSignInAttempt();

    expect(attempt.rawNonce).toMatch(/^nonce_[a-f0-9]{48}$/);
    expect(attempt.request.nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(attempt.request.nonce).not.toBe(attempt.rawNonce);
  });

  it("accepts only a response with the active attempt and Apple-returned state", () => {
    const request = {
      attemptId: "attempt_active",
      state: "state_active",
      nonce: "hashed_nonce",
    };

    expect(validateAppleSignInResponse(request, response())).toEqual(response());
    expect(() => validateAppleSignInResponse(request, response({ state: undefined }))).toThrow(
      "Apple sign-in response did not match the active request",
    );
    expect(() =>
      validateAppleSignInResponse(request, response({ state: "state_substituted" })),
    ).toThrow("Apple sign-in response did not match the active request");
  });
});
