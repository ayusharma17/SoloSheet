import assert from "node:assert/strict";
import test from "node:test";
import { paymentCall } from "../src/lib/payments.ts";

test("payment RPC responses are narrowed and malformed values fail closed", async () => {
  const ok = async () => ({
    data: { status: "fulfilled", purchaseId: "purchase", remainingCredits: 10 },
    error: null,
  });
  assert.deepEqual(await paymentCall(ok, "fulfill", {}), {
    status: "fulfilled",
    purchaseId: "purchase",
    remainingCredits: 10,
  });

  for (const data of [null, [], {}, { status: 1 }, { status: "ok", remainingCredits: -1 }]) {
    const rpc = async () => ({ data, error: null });
    await assert.rejects(paymentCall(rpc, "test", {}), /Payment transaction unavailable|Invalid payment/);
  }
  await assert.rejects(
    paymentCall(async () => ({ data: { status: "ok" }, error: new Error("db") }), "test", {}),
    /Payment transaction unavailable/,
  );
});
