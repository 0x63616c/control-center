import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AppleSignInResponse,
  authorizeAppleSignIn,
  createAppleSignInAttempt,
  validateAppleSignInResponse,
} from "./appleSignIn";

const nativeAuthorize = vi.hoisted(() => vi.fn());

vi.mock("@capacitor/core", () => ({
  registerPlugin: () => ({ authorize: nativeAuthorize }),
}));

function response(overrides: Partial<AppleSignInResponse> = {}): AppleSignInResponse {
  return {
    identityToken: "signed.identity.token",
    authorizationCode: "single-use-authorization-code",
    user: "apple-user-123",
    attemptId: "attempt_active",
    state: "state_active",
    ...overrides,
  };
}

describe("native Sign in with Apple request binding", () => {
  beforeEach(() => nativeAuthorize.mockReset());

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
    expect(() =>
      validateAppleSignInResponse(request, response({ attemptId: "attempt_replayed" })),
    ).toThrow("Apple sign-in response did not match the active request");
  });

  it("parses the untrusted Capacitor plugin response before exposing it", async () => {
    const request = {
      attemptId: "attempt_active",
      state: "state_active",
      nonce: "hashed_nonce",
    };
    nativeAuthorize.mockResolvedValue(response());

    await expect(authorizeAppleSignIn(request)).resolves.toEqual(response());

    nativeAuthorize.mockResolvedValue({ ...response(), identityToken: 123 });
    await expect(authorizeAppleSignIn(request)).rejects.toThrow();

    nativeAuthorize.mockResolvedValue({ ...response(), authorizationCode: "" });
    await expect(authorizeAppleSignIn(request)).rejects.toThrow();

    const { authorizationCode: _authorizationCode, ...withoutAuthorizationCode } = response();
    nativeAuthorize.mockResolvedValue(withoutAuthorizationCode);
    await expect(authorizeAppleSignIn(request)).rejects.toThrow();

    nativeAuthorize.mockResolvedValue({ ...response(), unexpected: "native-field" });
    await expect(authorizeAppleSignIn(request)).rejects.toThrow();
  });
});
