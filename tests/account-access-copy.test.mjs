import assert from "node:assert/strict";
import test from "node:test";
import {
  authErrorCodeFromCallback,
  authErrorMessage,
  displayedAuthError,
  parseAuthErrorCode,
} from "../src/lib/auth-ui.ts";
import {
  dashboardAccessState,
  purchaseStatusUpdate,
} from "../src/lib/dashboard-access.ts";
import { LAUNCH_TRIAL_OFFER, trialOfferCopy } from "../src/lib/product-copy.ts";

test("auth callback failures map to finite, user-safe error states", () => {
  assert.equal(authErrorCodeFromCallback("exchange_failed"), "oauth");
  assert.equal(authErrorCodeFromCallback("identity_failed"), "identity");
  assert.equal(authErrorCodeFromCallback("recovery_failed"), "profile");
  assert.equal(authErrorCodeFromCallback("cleanup_failed"), "service");

  assert.equal(parseAuthErrorCode("profile"), "profile");
  assert.equal(parseAuthErrorCode("unexpected"), null);
  assert.equal(parseAuthErrorCode("<script>alert(1)</script>"), null);
  assert.match(authErrorMessage("profile"), /finish setting up your account/i);
  assert.doesNotMatch(authErrorMessage("profile"), /database|rpc|supabase/i);
});

test("a fresh sign-in attempt dismisses stale callback errors but shows its own failure", () => {
  assert.equal(displayedAuthError({
    callbackError: "profile",
    attemptError: null,
    callbackErrorDismissed: false,
  }), "profile");
  assert.equal(displayedAuthError({
    callbackError: "profile",
    attemptError: null,
    callbackErrorDismissed: true,
  }), null);
  assert.equal(displayedAuthError({
    callbackError: "profile",
    attemptError: "oauth",
    callbackErrorDismissed: true,
  }), "oauth");
});

test("dashboard access keeps zero credits, holds, and lookup failures distinct", () => {
  assert.equal(dashboardAccessState({ isAdmin: false, isAccountHeld: false, credits: 1 }), "ready");
  assert.equal(dashboardAccessState({ isAdmin: false, isAccountHeld: false, credits: 0 }), "out_of_credits");
  assert.equal(dashboardAccessState({ isAdmin: false, isAccountHeld: true, credits: 0 }), "account_held");
  assert.equal(dashboardAccessState({ isAdmin: false, isAccountHeld: false, credits: null }), "credit_unavailable");
  assert.equal(dashboardAccessState({ isAdmin: true, isAccountHeld: false, credits: 0 }), "admin");
  assert.equal(dashboardAccessState({ isAdmin: true, isAccountHeld: false, credits: null }), "admin");
  assert.equal(dashboardAccessState({ isAdmin: true, isAccountHeld: true, credits: null }), "account_held");
});

test("purchase polling applies only complete balance and hold snapshots", () => {
  assert.deepEqual(
    purchaseStatusUpdate({ status: "paid", credits: 10, accountHeld: false }),
    { credits: 10, isAccountHeld: false, state: "paid" },
  );
  assert.deepEqual(
    purchaseStatusUpdate({ status: "paid", credits: 10, accountHeld: true }),
    { credits: 10, isAccountHeld: true, state: "held" },
  );
  assert.deepEqual(
    purchaseStatusUpdate({ status: "pending", credits: 0, accountHeld: false }),
    { credits: 0, isAccountHeld: false, state: "pending" },
  );
  assert.equal(purchaseStatusUpdate({ status: "paid", accountHeld: false }), null);
  assert.equal(purchaseStatusUpdate({ status: "paid", credits: 10 }), null);
  assert.equal(purchaseStatusUpdate({ status: "paid", credits: null, accountHeld: false }), null);
  assert.equal(purchaseStatusUpdate({ status: "paid", credits: -1, accountHeld: false }), null);
  assert.equal(purchaseStatusUpdate({ status: "unexpected", credits: 10, accountHeld: false }), null);
  assert.equal(purchaseStatusUpdate({ status: "unexpected", credits: 10, accountHeld: true }), null);
});

test("public trial copy covers both the launch-On and future flag-Off states", () => {
  assert.equal(LAUNCH_TRIAL_OFFER, "1 free credit for every new account");
  assert.doesNotMatch(LAUNCH_TRIAL_OFFER, /\.edu|required|eligible/i);

  const flagOffCopy = trialOfferCopy(false);
  assert.match(flagOffCopy, /\.edu/i);
  assert.match(flagOffCopy, /any verified Google account can sign up/i);
  assert.doesNotMatch(flagOffCopy, /every new account/i);
});
