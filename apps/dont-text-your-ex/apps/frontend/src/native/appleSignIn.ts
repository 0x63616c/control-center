import { registerPlugin } from "@capacitor/core";
import { z } from "zod";

type AppleSignInPlugin = {
  authorize(input: AppleSignInRequest): Promise<unknown>;
};

export type AppleSignInRequest = {
  readonly attemptId: string;
  readonly state: string;
  readonly nonce: string;
};

export type AppleSignInResponse = {
  readonly identityToken: string;
  readonly authorizationCode: string;
  readonly user: string;
  readonly fullName?: string;
  readonly attemptId: string;
  readonly state?: string;
};

const AppleSignInResponseSchema = z
  .object({
    identityToken: z.string().min(1),
    authorizationCode: z.string().min(1),
    user: z.string().min(1),
    fullName: z.string().optional(),
    attemptId: z.string().min(1),
    state: z.string().optional(),
  })
  .strict();

export type AppleSignInAttempt = {
  readonly request: AppleSignInRequest;
  readonly rawNonce: string;
};

const AppleSignIn = registerPlugin<AppleSignInPlugin>("AppleSignIn");

function randomPart(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createAppleSignInAttempt(): Promise<AppleSignInAttempt> {
  const rawNonce = `nonce_${randomPart()}`;
  return {
    request: {
      attemptId: `attempt_${randomPart()}`,
      state: `state_${randomPart()}`,
      nonce: await sha256(rawNonce),
    },
    rawNonce,
  };
}

export function validateAppleSignInResponse(
  request: AppleSignInRequest,
  response: AppleSignInResponse,
): AppleSignInResponse {
  if (response.attemptId !== request.attemptId || response.state !== request.state) {
    throw new Error("Apple sign-in response did not match the active request");
  }
  return response;
}

export async function authorizeAppleSignIn(
  input: AppleSignInRequest,
): Promise<AppleSignInResponse> {
  return AppleSignInResponseSchema.parse(await AppleSignIn.authorize(input));
}
