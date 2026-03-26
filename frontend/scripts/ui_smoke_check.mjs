import { chromium } from "playwright";

const pagesToCheck = [
  "/login",
  "/home",
  "/library",
  "/categories",
  "/series",
  "/writers",
  "/manual-books",
  "/processing-my-requests",
  "/processing-catalog-books",
  "/processing-incomplete-check",
  "/processing-all-activity",
  "/access",
];

const sessionId = process.argv[2] || "";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL: "http://localhost:5173" });

if (sessionId) {
  await context.addCookies([
    {
      name: "sessionid",
      value: sessionId,
      domain: "localhost",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

const results = [];

for (const path of pagesToCheck) {
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });

  page.on("pageerror", (err) => {
    pageErrors.push(String(err));
  });

  let status = null;
  try {
    const response = await page.goto(path, {
      waitUntil: "networkidle",
      timeout: 30000,
    });
    status = response ? response.status() : null;
  } catch (error) {
    pageErrors.push(String(error));
  }

  let loginHeaderSignInVisible = null;
  if (path === "/login") {
    const signInCount = await page
      .locator(".app-topbar .ghost-button", { hasText: "Sign in" })
      .count();
    loginHeaderSignInVisible = signInCount > 0;
  }

  results.push({
    path,
    status,
    consoleErrorCount: consoleErrors.length,
    pageErrorCount: pageErrors.length,
    loginHeaderSignInVisible,
    sampleConsoleError: consoleErrors[0] || "",
    samplePageError: pageErrors[0] || "",
  });

  await page.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
