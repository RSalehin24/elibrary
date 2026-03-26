import fs from "node:fs";
import { execSync } from "node:child_process";
import { chromium } from "playwright";

const envText = fs.readFileSync(
  "/Users/rsalehin24/Documents/ebook-scrapping/.env",
  "utf8",
);
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => !line.startsWith("#"))
    .map((line) => {
      const idx = line.indexOf("=");
      return [line.slice(0, idx), line.slice(idx + 1)];
    }),
);

const email = env.SUPER_ADMIN_EMAIL;
const password = process.env.WALKTHROUGH_PASSWORD || env.SUPER_ADMIN_PASSWORD;
if (!email || !password) {
  throw new Error("Missing super admin credentials in .env");
}

const base = "http://127.0.0.1:5173";
const artifacts =
  "/Users/rsalehin24/Documents/ebook-scrapping/frontend/test-artifacts";
fs.mkdirSync(artifacts, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();

const step = async (name) => {
  await page.screenshot({ path: `${artifacts}/${name}.png`, fullPage: true });
};

await page.goto(`${base}/login`, { waitUntil: "networkidle" });
await step("login-page");

const loginResponse = await context.request.post(
  "http://127.0.0.1:8000/api/auth/login/",
  {
    data: { email, password },
  },
);
if (!loginResponse.ok()) {
  throw new Error(
    `API login failed: ${loginResponse.status()} ${await loginResponse.text()}`,
  );
}
await step("login-success");

await page.goto(`${base}/processing-my-requests`, { waitUntil: "networkidle" });
await step("processing-my-requests");

for (const [name, path] of [
  ["catalog-books", "/processing-catalog-books"],
  ["automation", "/processing-automation"],
  ["all-activity", "/processing-all-activity"],
  ["incomplete-check", "/processing-incomplete-check"],
]) {
  await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
  await page.waitForLoadState("networkidle");
  await step(`processing-page-${name}`);
}
await page.goto(`${base}/processing-my-requests`, { waitUntil: "networkidle" });
await page.waitForLoadState("networkidle");
const firstFilterToggle = page.locator("button.catalog-filter-toggle").first();
if (await firstFilterToggle.count()) {
  await firstFilterToggle.click();
  await page.waitForTimeout(350);
  await step("filters-opened");
  const applyButton = page
    .locator(".catalog-filter-actions .primary-button")
    .first();
  await applyButton.click();
  await page.waitForLoadState("networkidle");
  const spinnerSlotExists = await page.evaluate(() =>
    Boolean(document.querySelector(".button-label-spinner-slot")),
  );
  if (spinnerSlotExists) {
    throw new Error("Hidden filter spinner slot still exists in DOM.");
  }
  await step("filters-applied-no-slot");
}

execSync("docker-compose stop backend", {
  cwd: "/Users/rsalehin24/Documents/ebook-scrapping",
  stdio: "ignore",
});
await page.waitForTimeout(3000);
await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("text=There is an error.", { timeout: 20000 });
await step("backend-down-modal");

execSync("docker-compose start backend", {
  cwd: "/Users/rsalehin24/Documents/ebook-scrapping",
  stdio: "ignore",
});
for (let i = 0; i < 60; i += 1) {
  const visible = await page.locator("text=There is an error.").count();
  if (!visible) {
    break;
  }
  await page.waitForTimeout(1000);
  await page.reload({ waitUntil: "domcontentloaded" });
}
await page.waitForTimeout(1000);
await step("backend-up-recovered");

await browser.close();
console.log("Walkthrough scripts completed.");
