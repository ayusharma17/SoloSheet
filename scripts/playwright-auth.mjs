import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const email = process.env.PLAYWRIGHT_EMAIL || "playwright@example.edu";
const password = process.env.PLAYWRIGHT_PASSWORD || "local-playwright-password-123";
const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3000";
const headless = process.env.PLAYWRIGHT_HEADLESS === "true";
const browser = await chromium.launch({ headless });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(`${baseURL}/login`);
await page.getByLabel("Email").fill(email);
await page.getByLabel("Password").fill(password);
await page.getByRole("button", { name: /sign in to local test account/i }).click();
await page.waitForURL("**/dashboard");
await mkdir("playwright/.auth", { recursive: true });
await context.storageState({ path: "playwright/.auth/user.json" });
console.log("Saved Playwright auth state to playwright/.auth/user.json");
await browser.close();
