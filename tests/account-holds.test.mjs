import assert from "node:assert/strict";
import test from "node:test";
import { isAccountHeld } from "../src/lib/account-holds.ts";

test("account hold lookup uses only a non-empty authenticated user ID", async () => {
  const seen = [];
  const lookup = async (userId) => {
    seen.push(userId);
    return userId === "held-user";
  };

  assert.equal(await isAccountHeld("held-user", lookup), true);
  assert.equal(await isAccountHeld("active-user", lookup), false);
  assert.equal(await isAccountHeld("", lookup), false);
  assert.deepEqual(seen, ["held-user", "active-user"]);
});
