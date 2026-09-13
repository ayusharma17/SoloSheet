/** Durable credit workflow; RPC implementations enforce atomicity in PostgreSQL. */
export type CreditResult = {
  status?: string;
  materialId?: string | null;
  remainingCredits?: number;
};
export type CreditRpc = (name: string, args: Record<string, unknown>) => PromiseLike<{
  data: unknown;
  error: unknown;
}>;

export async function creditCall(rpc: CreditRpc, name: string, args: Record<string, unknown>): Promise<CreditResult> {
  const { data, error } = await rpc(name, args);
  if (error || !data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Credit transaction unavailable");
  }
  const value = data as Record<string, unknown>;
  if ((value.status !== undefined && typeof value.status !== "string") ||
      (value.materialId !== undefined && value.materialId !== null && typeof value.materialId !== "string") ||
      (value.remainingCredits !== undefined && (!Number.isInteger(value.remainingCredits) || Number(value.remainingCredits) < 0))) {
    throw new Error("Invalid credit transaction response");
  }
  return value as CreditResult;
}

export async function finishExtraction<T>(options: {
  rpc: CreditRpc;
  identity: { p_user_id: string; p_request_id: string };
  generate: () => Promise<T>;
  completion: Record<string, unknown>;
}): Promise<CreditResult> {
  try {
    const items = await options.generate();
    return await creditCall(options.rpc, "complete_extraction", {
      ...options.identity, ...options.completion, p_items: items,
    });
  } catch (error) {
    // Resolve ambiguous commit responses before reporting failure. The database
    // refunds only active reservations; completed requests remain charged.
    const settled = await creditCall(options.rpc, "fail_extraction", options.identity);
    if (settled.status === "completed" && settled.materialId) return settled;
    throw error;
  }
}
