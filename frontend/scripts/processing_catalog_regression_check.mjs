import fs from "node:fs";
import { chromium } from "playwright";

function readEnvFile(path) {
  return Object.fromEntries(
    fs
      .readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const idx = line.indexOf("=");
        return [line.slice(0, idx), line.slice(idx + 1)];
      }),
  );
}

const env = readEnvFile(new URL("../../.env", import.meta.url));
const base = process.argv[2] || "http://127.0.0.1:4174";
const backend = process.argv[3] || "http://127.0.0.1:8000";
const runs = Number(process.argv[4] || 5);
const waitSeconds = Number(process.argv[5] || 180);

const browser = await chromium.launch({ headless: true });
const results = [];

for (let run = 1; run <= runs; run += 1) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const login = await context.request.post(`${backend}/api/auth/login/`, {
    data: {
      email: env.SUPER_ADMIN_EMAIL,
      password: env.SUPER_ADMIN_PASSWORD,
    },
  });
  if (!login.ok()) {
    throw new Error(
      `Login failed on run ${run}: ${login.status()} ${await login.text()}`,
    );
  }

  const page = await context.newPage();
  const failures = [];
  const consoleErrors = [];
  const pageErrors = [];
  const seenToasts = new Set();

  page.on("response", (response) => {
    if (response.request().url().includes("/api/") && response.status() >= 400) {
      failures.push({
        url: response.url(),
        status: response.status(),
        method: response.request().method(),
      });
    }
  });

  page.on("requestfailed", (request) => {
    if (request.url().includes("/api/")) {
      failures.push({
        url: request.url(),
        status: "requestfailed",
        method: request.method(),
        error: request.failure()?.errorText || "",
      });
    }
  });

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });

  page.on("pageerror", (error) => {
    pageErrors.push(String(error));
  });

  await page.goto(`${base}/processing-catalog-books`, {
    waitUntil: "networkidle",
  });

  const uiChecks = await page.evaluate(() => {
    const byHeading = (title) =>
      Array.from(
        document.querySelectorAll("section.processing-card, section.detail-card"),
      ).find((section) => section.querySelector("h2")?.textContent?.trim() === title);

    const summarizeCard = (title) => {
      const card = byHeading(title);
      if (!card) {
        return { found: false, searchInputs: 0, resultCounts: 0 };
      }
      return {
        found: true,
        searchInputs: card.querySelectorAll('input[type="search"]').length,
        resultCounts: card.querySelectorAll(".catalog-result-count").length,
      };
    };

    const summarizeActionCard = (title) => {
      const card = byHeading(title);
      if (!card) {
        return { found: false, rows: 0, rowButtonCounts: [] };
      }
      const rows = Array.from(
        card.querySelectorAll(".processing-bulk-bar .processing-card-action-row"),
      );
      return {
        found: true,
        rows: rows.length,
        rowButtonCounts: rows.map((row) => row.querySelectorAll("button").length),
      };
    };

    return {
      failedCatalog: summarizeCard("Failed Catalog"),
      requeuedCatalog: summarizeCard("Requeued Catalog"),
      requeuedJobs: summarizeActionCard("Requeued Jobs Create Queue"),
      failedJobs: summarizeActionCard("Failed Jobs Create Queue"),
    };
  });

  for (let second = 0; second < waitSeconds; second += 1) {
    const texts = await page.locator(".toast").allTextContents();
    for (const text of texts.map((value) => value.trim()).filter(Boolean)) {
      seenToasts.add(text);
    }
    await page.waitForTimeout(1000);
  }

  results.push({
    run,
    uiChecks,
    failures,
    consoleErrors,
    pageErrors,
    toastTexts: [...seenToasts],
  });

  await context.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
