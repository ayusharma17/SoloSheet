import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3000";
const browser = await chromium.launch({ headless: process.env.PLAYWRIGHT_HEADLESS !== "false" });
const context = await browser.newContext({ storageState: "playwright/.auth/user.json" });
const page = await context.newPage();
const browserErrors = [];
let extractionRequests = 0;
let requestId;

page.on("pageerror", error => browserErrors.push(`pageerror: ${error.message}`));
page.on("console", message => {
  if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
});

await page.route("**/api/extract", async route => {
  const payload = route.request().postDataJSON();
  assert.equal(typeof payload?.requestId, "string");
  if (requestId === undefined) requestId = payload.requestId;
  else assert.equal(payload.requestId, requestId, "retry must preserve the extraction request ID");
  extractionRequests += 1;
  await route.fulfill({
    status: extractionRequests === 1 ? 503 : 409,
    contentType: "application/json",
    body: JSON.stringify(extractionRequests === 1
      ? { error: "Synthetic provider outage" }
      : { error: "Synthetic restart required", code: "EXTRACTION_RESTART_REQUIRED" }),
  });
});

try {
  const dashboard = await page.goto(`${baseURL}/dashboard`, { waitUntil: "networkidle" });
  assert.equal(dashboard?.status(), 200);
  assert.equal(new URL(page.url()).pathname, "/dashboard");
  assert.match(await page.locator("h1").textContent(), /Welcome, Playwright/i);
  assert.match(await page.locator("header").textContent(), /1\s+credits/i);

  await page.getByRole("button", { name: "Initiate Upload" }).click();
  const dialog = page.getByRole("dialog", { name: "Create Cheat Sheet" });
  await dialog.waitFor();
  const fileInput = dialog.locator('input[type="file"]');
  await fileInput.setInputFiles({ name: "unsupported.txt", mimeType: "text/plain", buffer: Buffer.from("fixture") });
  assert.match(await dialog.getByRole("alert").textContent(), /unsupported extension/i);

  await fileInput.setInputFiles("Test_Files/synthetic/solosheet-synthetic-notes.pdf");
  await dialog.getByLabel("Course Name").fill("Local E2E Verification");
  await dialog.getByRole("button", { name: "Generate" }).click();
  await dialog.getByText(/Synthetic provider outage/i).waitFor();
  await dialog.getByRole("button", { name: "Retry request" }).click();
  await dialog.getByText(/Synthetic restart required/i).waitFor();
  await dialog.getByRole("button", { name: "Generate" }).waitFor();
  assert.equal(extractionRequests, 2);

  await dialog.getByRole("button", { name: "Close upload dialog" }).click();
  await page.getByTitle("Sign Out").click();
  await page.waitForURL("**/login");
  await page.goto(`${baseURL}/dashboard`);
  await page.waitForURL("**/login");
  const expectedMockFailures = ["status of 503", "status of 409"];
  const unexpectedBrowserErrors = browserErrors.filter(error =>
    !expectedMockFailures.some(expected => error.includes(expected))
  );
  assert.deepEqual(unexpectedBrowserErrors, []);
  console.log("Authenticated dashboard, upload, idempotent retry, cleanup, and sign-out checks passed");
} finally {
  await browser.close();
}
