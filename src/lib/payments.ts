export type PaymentResult = {
  status: string;
  purchaseId?: string;
  remainingCredits?: number;
};

export type PaymentRpc = (
  name: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: unknown }>;

export async function paymentCall(
  rpc: PaymentRpc,
  name: string,
  args: Record<string, unknown>,
): Promise<PaymentResult> {
  const { data, error } = await rpc(name, args);
  if (error || !data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Payment transaction unavailable");
  }
  const value = data as Record<string, unknown>;
  if (typeof value.status !== "string" ||
      (value.purchaseId !== undefined && typeof value.purchaseId !== "string") ||
      (value.remainingCredits !== undefined &&
        (!Number.isInteger(value.remainingCredits) || Number(value.remainingCredits) < 0))) {
    throw new Error("Invalid payment transaction response");
  }
  return value as PaymentResult;
}
