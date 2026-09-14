import { chromium } from "playwright";

const email = process.env.PLAYWRIGHT_EMAIL || "playwright@example.edu";
const password = process.env.PLAYWRIGHT_PASSWORD || "local-playwright-password-123";
const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3000";
const context = await chromium.launchPersistentContext("playwright/.profile", { headless: false });
const page = context.pages()[0] || await context.newPage();
await page.goto(`${baseURL}/login`);
await page.getByLabel("Email").fill(email);
await page.getByLabel("Password").fill(password);
await page.getByRole("button", { name: /sign in to local test account/i }).click();
await page.waitForURL("**/dashboard");
await context.storageState({ path: "playwright/.auth/user.json" });
console.log("Saved Playwright auth state to playwright/.auth/user.json");
await context.close();
