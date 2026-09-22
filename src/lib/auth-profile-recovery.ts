export type VerifiedAuthUser = {
  id: string;
  email: string;
  email_confirmed_at: string;
};

export function isVerifiedAuthUser(value: unknown): value is VerifiedAuthUser {
  if (!value || typeof value !== "object") return false;
  const user = value as Record<string, unknown>;
  return typeof user.id === "string" && user.id.length > 0 &&
    typeof user.email === "string" && user.email.trim().length > 0 &&
    typeof user.email_confirmed_at === "string" && user.email_confirmed_at.length > 0;
}

export function isConfirmedProfileRecovery(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const status = (value as Record<string, unknown>).status;
  return status === "repaired" || status === "existing";
}

export type AuthCallbackOutcome =
  | "complete"
  | "exchange_failed"
  | "identity_failed"
  | "recovery_failed"
  | "cleanup_failed";

type AuthCallbackOperations = {
  exchangeCode: () => Promise<boolean>;
  getUser: () => Promise<{ user: unknown; failed: boolean }>;
  repairProfile: () => Promise<{ result: unknown; failed: boolean }>;
  clearLocalSession: () => Promise<boolean>;
};

export async function completeAuthCallback(
  operations: AuthCallbackOperations,
): Promise<AuthCallbackOutcome> {
  let exchanged = false;
  try {
    exchanged = await operations.exchangeCode();
  } catch {
    return "exchange_failed";
  }
  if (!exchanged) return "exchange_failed";

  const failAfterExchange = async (
    outcome: "identity_failed" | "recovery_failed",
  ): Promise<AuthCallbackOutcome> => {
    // Retry once because Supabase sign-out can fail before it removes the SSR
    // session cookie. A bounded retry handles a transient Auth failure without
    // turning this callback into an unbounded request.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (await operations.clearLocalSession()) return outcome;
      } catch {
        // A thrown cleanup attempt is equivalent to a returned failure. Retry
        // once, then surface cleanup_failed so the callback never redirects.
      }
    }
    return "cleanup_failed";
  };

  let identity: Awaited<ReturnType<AuthCallbackOperations["getUser"]>>;
  try {
    identity = await operations.getUser();
  } catch {
    return failAfterExchange("identity_failed");
  }
  if (identity.failed || !isVerifiedAuthUser(identity.user)) {
    return failAfterExchange("identity_failed");
  }

  let recovery: Awaited<ReturnType<AuthCallbackOperations["repairProfile"]>>;
  try {
    recovery = await operations.repairProfile();
  } catch {
    return failAfterExchange("recovery_failed");
  }
  if (recovery.failed || !isConfirmedProfileRecovery(recovery.result)) {
    return failAfterExchange("recovery_failed");
  }

  return "complete";
}
