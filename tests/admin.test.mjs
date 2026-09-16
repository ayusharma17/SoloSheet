import assert from "node:assert/strict";
import test from "node:test";
import { isAdminUser } from "../src/lib/admin.ts";

test("only confirmed database-allowlisted users receive admin access", async () => {
  const lookup = async (email) => email === "admin@example.edu";
  assert.equal(await isAdminUser({ email: " ADMIN@example.edu ", email_confirmed_at: "2026-01-01" }, lookup), true);
  assert.equal(await isAdminUser({ email: "Admin@example.edu" }, lookup), false);
  assert.equal(await isAdminUser({ email: "student@example.edu", email_confirmed_at: "2026-01-01" }, lookup), false);
  assert.equal(await isAdminUser({ email_confirmed_at: "2026-01-01" }, lookup), false);
});
