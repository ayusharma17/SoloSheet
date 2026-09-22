export type DashboardAccessState =
  | "ready"
  | "admin"
  | "out_of_credits"
  | "account_held"
  | "credit_unavailable";

export function dashboardAccessState(options: {
  isAdmin: boolean;
  isAccountHeld: boolean;
  credits: number | null;
}): DashboardAccessState {
  if (options.isAccountHeld) return "account_held";
  if (options.isAdmin) return "admin";
  if (options.credits === null) return "credit_unavailable";
  return options.credits <= 0 ? "out_of_credits" : "ready";
}

export type PurchasePollState =
  | "paid"
  | "held"
  | "reversed"
  | "unconfirmed"
  | "pending";

export type PurchaseStatusUpdate = {
  credits: number;
  isAccountHeld: boolean;
  state: PurchasePollState;
};

/**
 * Treat the purchase status as one atomic snapshot. A response that omits the
 * balance or hold state must not make an unavailable profile appear usable or
 * announce a payment result that the UI cannot corroborate.
 */
export function purchaseStatusUpdate(value: unknown): PurchaseStatusUpdate | null {
  if (!value || typeof value !== "object") return null;

  const { status, credits, accountHeld } = value as {
    status?: unknown;
    credits?: unknown;
    accountHeld?: unknown;
  };
  if (typeof status !== "string" ||
      !Number.isInteger(credits) || Number(credits) < 0 ||
      typeof accountHeld !== "boolean") {
    return null;
  }

  const knownStatus = status === "pending" || status === "paid" ||
    status === "refunded" || status === "disputed" ||
    status === "chargeback" || status === "failed" ||
    status === "expired" || status === "canceled";
  if (!knownStatus) return null;

  if (accountHeld) {
    return { credits: Number(credits), isAccountHeld: true, state: "held" };
  }
  if (status === "paid") {
    return { credits: Number(credits), isAccountHeld: false, state: "paid" };
  }
  if (["refunded", "disputed", "chargeback"].includes(status)) {
    return { credits: Number(credits), isAccountHeld: false, state: "reversed" };
  }
  if (["failed", "expired", "canceled"].includes(status)) {
    return { credits: Number(credits), isAccountHeld: false, state: "unconfirmed" };
  }
  return { credits: Number(credits), isAccountHeld: false, state: "pending" };
}
