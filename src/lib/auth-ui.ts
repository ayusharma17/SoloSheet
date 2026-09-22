import type { AuthCallbackOutcome } from "@/lib/auth-profile-recovery";

export const AUTH_ERROR_CODES = ["oauth", "identity", "profile", "service"] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export function authErrorCodeFromCallback(
  outcome: Exclude<AuthCallbackOutcome, "complete">,
): AuthErrorCode {
  switch (outcome) {
    case "exchange_failed":
      return "oauth";
    case "identity_failed":
      return "identity";
    case "recovery_failed":
      return "profile";
    case "cleanup_failed":
      return "service";
  }
}

export function parseAuthErrorCode(value: string | null): AuthErrorCode | null {
  return AUTH_ERROR_CODES.find((code) => code === value) ?? null;
}

export function displayedAuthError(options: {
  callbackError: AuthErrorCode | null;
  attemptError: AuthErrorCode | null;
  callbackErrorDismissed: boolean;
}): AuthErrorCode | null {
  if (options.attemptError) return options.attemptError;
  return options.callbackErrorDismissed ? null : options.callbackError;
}

export function authErrorMessage(code: AuthErrorCode): string {
  switch (code) {
    case "oauth":
      return "Google sign-in did not complete. Please try again.";
    case "identity":
      return "We could not verify your Google account. Please choose a verified Google account and try again.";
    case "profile":
      return "Your identity was verified, but SoloSheet could not finish setting up your account. Please try again.";
    case "service":
      return "Sign-in is temporarily unavailable. Please try again in a moment.";
  }
}
