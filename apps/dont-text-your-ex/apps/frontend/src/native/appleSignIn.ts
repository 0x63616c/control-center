import { registerPlugin } from "@capacitor/core";

type AppleSignInPlugin = {
  authorize(input: AppleSignInRequest): Promise<AppleSignInResponse>;
};

export type AppleSignInRequest = {
  readonly attemptId: string;
  readonly state: string;
  readonly nonce: string;
};

export type AppleSignInResponse = {
  readonly identityToken: string;
  readonly hasAuthorizationCode: boolean;
  readonly user: string;
  readonly fullName?: string;
  readonly attemptId: string;
  readonly state: string;
  readonly nonce: string;
};

const AppleSignIn = registerPlugin<AppleSignInPlugin>("AppleSignIn");

function randomPart(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createAppleSignInRequest(): AppleSignInRequest {
  return {
    attemptId: `attempt_${randomPart()}`,
    state: `state_${randomPart()}`,
    nonce: `nonce_${randomPart()}`,
  };
}

export function authorizeAppleSignIn(input: AppleSignInRequest): Promise<AppleSignInResponse> {
  return AppleSignIn.authorize(input);
}
