import assert from "node:assert/strict";
import test from "node:test";
import { isAdminUser } from "../src/lib/admin.ts";

test("only confirmed allowlisted server users receive admin access", () => {
  const previous = process.env.ADMIN_EMAILS;
  try {
    process.env.ADMIN_EMAILS = " Admin@example.edu, ,other@example.edu ";
    assert.equal(isAdminUser({ email: "ADMIN@example.edu", email_confirmed_at: "2026-01-01" }), true);
    assert.equal(isAdminUser({ email: "Admin@example.edu" }), false);
    assert.equal(isAdminUser({ email: "student@example.edu", email_confirmed_at: "2026-01-01" }), false);
    assert.equal(isAdminUser({ email_confirmed_at: "2026-01-01" }), false);
    process.env.ADMIN_EMAILS = "";
    assert.equal(isAdminUser({ email: "Admin@example.edu", email_confirmed_at: "2026-01-01" }), false);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = previous;
  }
});
