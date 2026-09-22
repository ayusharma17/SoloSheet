import assert from "node:assert/strict";
import test from "node:test";
import {
  completeAuthCallback,
  isConfirmedProfileRecovery,
  isVerifiedAuthUser,
} from "../src/lib/auth-profile-recovery.ts";

function callbackOperations(overrides = {}) {
  return {
    exchangeCode: async () => true,
    getUser: async () => ({
      user: {
        id: "user-id",
        email: "person@example.com",
        email_confirmed_at: "2026-09-18T00:00:00Z",
      },
      failed: false,
    }),
    repairProfile: async () => ({ result: { status: "existing" }, failed: false }),
    clearLocalSession: async () => true,
    ...overrides,
  };
}

test("verified callback identities require id, email, and confirmation", () => {
  assert.equal(isVerifiedAuthUser({
    id: "user-id",
    email: "person@example.com",
    email_confirmed_at: "2026-09-18T00:00:00Z",
  }), true);
  assert.equal(isVerifiedAuthUser({ id: "user-id", email: "person@example.com" }), false);
  assert.equal(isVerifiedAuthUser({
    id: "user-id",
    email: "   ",
    email_confirmed_at: "2026-09-18T00:00:00Z",
  }), false);
  assert.equal(isVerifiedAuthUser(null), false);
});

test("only explicit repaired or existing RPC results confirm a profile", () => {
  assert.equal(isConfirmedProfileRecovery({ status: "repaired" }), true);
  assert.equal(isConfirmedProfileRecovery({ status: "existing" }), true);
  assert.equal(isConfirmedProfileRecovery({ status: "failed" }), false);
  assert.equal(isConfirmedProfileRecovery([{ status: "existing" }]), false);
  assert.equal(isConfirmedProfileRecovery(null), false);
});

test("callback completes only after exchange, verified identity, and profile confirmation", async () => {
  assert.equal(await completeAuthCallback(callbackOperations()), "complete");
  assert.equal(await completeAuthCallback(callbackOperations({
    repairProfile: async () => ({ result: { status: "repaired" }, failed: false }),
  })), "complete");
  assert.equal(await completeAuthCallback(callbackOperations({
    exchangeCode: async () => false,
  })), "exchange_failed");
});

test("callback clears only its local session after identity or recovery failure", async () => {
  let cleanupCalls = 0;
  const clearLocalSession = async () => { cleanupCalls += 1; return true; };

  assert.equal(await completeAuthCallback(callbackOperations({
    getUser: async () => ({ user: null, failed: true }),
    clearLocalSession,
  })), "identity_failed");
  assert.equal(await completeAuthCallback(callbackOperations({
    repairProfile: async () => ({ result: null, failed: true }),
    clearLocalSession,
  })), "recovery_failed");
  assert.equal(await completeAuthCallback(callbackOperations({
    repairProfile: async () => ({ result: { status: "unexpected" }, failed: false }),
    clearLocalSession,
  })), "recovery_failed");
  assert.equal(cleanupCalls, 3);
});

test("callback reports failed cleanup and never cleans up an exchange failure", async () => {
  let cleanupCalls = 0;
  assert.equal(await completeAuthCallback(callbackOperations({
    getUser: async () => ({ user: {}, failed: false }),
    clearLocalSession: async () => { cleanupCalls += 1; return false; },
  })), "cleanup_failed");
  assert.equal(await completeAuthCallback(callbackOperations({
    exchangeCode: async () => false,
    clearLocalSession: async () => { cleanupCalls += 1; return true; },
  })), "exchange_failed");
  assert.equal(cleanupCalls, 2);
});

test("callback fails closed when an auth operation throws", async () => {
  let cleanupCalls = 0;
  const clearLocalSession = async () => { cleanupCalls += 1; return true; };

  assert.equal(await completeAuthCallback(callbackOperations({
    exchangeCode: async () => { throw new Error("provider unavailable"); },
    clearLocalSession,
  })), "exchange_failed");
  assert.equal(cleanupCalls, 0);

  assert.equal(await completeAuthCallback(callbackOperations({
    getUser: async () => { throw new Error("identity unavailable"); },
    clearLocalSession,
  })), "identity_failed");
  assert.equal(await completeAuthCallback(callbackOperations({
    repairProfile: async () => { throw new Error("database unavailable"); },
    clearLocalSession,
  })), "recovery_failed");
  assert.equal(cleanupCalls, 2);
});

test("callback reports cleanup failure when local sign-out throws", async () => {
  let cleanupCalls = 0;
  assert.equal(await completeAuthCallback(callbackOperations({
    repairProfile: async () => ({ result: null, failed: true }),
    clearLocalSession: async () => {
      cleanupCalls += 1;
      throw new Error("cookie cleanup unavailable");
    },
  })), "cleanup_failed");
  assert.equal(cleanupCalls, 2);
});

test("callback accepts the original failure after a cleanup retry succeeds", async () => {
  let returnedFailureCalls = 0;
  assert.equal(await completeAuthCallback(callbackOperations({
    repairProfile: async () => ({ result: null, failed: true }),
    clearLocalSession: async () => {
      returnedFailureCalls += 1;
      return returnedFailureCalls === 2;
    },
  })), "recovery_failed");
  assert.equal(returnedFailureCalls, 2);

  let thrownFailureCalls = 0;
  assert.equal(await completeAuthCallback(callbackOperations({
    getUser: async () => ({ user: null, failed: true }),
    clearLocalSession: async () => {
      thrownFailureCalls += 1;
      if (thrownFailureCalls === 1) throw new Error("transient failure");
      return true;
    },
  })), "identity_failed");
  assert.equal(thrownFailureCalls, 2);
});
