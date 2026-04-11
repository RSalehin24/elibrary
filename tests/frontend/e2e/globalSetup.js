import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getLiveBaseUrls, getRepoRoot, loadLocalEnv } from "./support/liveEnv";

const require = createRequire(
  new URL("../../../app/frontend/package.json", import.meta.url),
);
const { chromium } = require("playwright");

async function waitForUrl(url, timeoutMs = 120_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.ok || response.status === 302 || response.status === 401) {
        return;
      }
    } catch {}
    await delay(1000);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function writeSuperAdminStorageState({ frontend, repoRoot }) {
  const env = loadLocalEnv();
  const authStatePath = path.join(
    repoRoot,
    "tests/frontend/.auth/superadmin.json",
  );
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: frontend });
  const page = await context.newPage();

  await page.goto("/login");
  await page.getByLabel("Email").fill(
    env.SUPER_ADMIN_EMAIL || "admin@example.com",
  );
  await page
    .locator("label", { hasText: "Password" })
    .locator("input")
    .first()
    .fill(env.SUPER_ADMIN_PASSWORD || "changeme");
  await page.getByRole("button", { name: /Continue|Verify/ }).click();
  await Promise.race([
    page.waitForURL("**/home", { timeout: 15_000 }).catch(() => null),
    page
      .getByRole("heading", { name: "All Books" })
      .waitFor({
        state: "visible",
        timeout: 15_000,
      })
      .catch(() => null),
  ]);
  await page.goto("/home", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "All Books" }).waitFor({
    state: "visible",
    timeout: 15_000,
  });

  fs.mkdirSync(path.dirname(authStatePath), { recursive: true });
  await context.storageState({ path: authStatePath });
  await browser.close();
}

export default async function globalSetup() {
  loadLocalEnv();
  const repoRoot = getRepoRoot();
  const { frontend, backend } = getLiveBaseUrls();
  const backendSessionUrl = `${backend.replace(/\/$/, "")}/api/auth/session/`;

  if (process.env.PLAYWRIGHT_SKIP_STACK_START !== "1") {
    execFileSync(path.join(repoRoot, "local/scripts/dev.sh"), ["up"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  }

  await Promise.all([waitForUrl(frontend), waitForUrl(backendSessionUrl)]);

  if (process.env.PLAYWRIGHT_SKIP_E2E_SEED !== "1") {
    execFileSync(path.join(repoRoot, "tests/scripts/seed-e2e-data.sh"), {
      cwd: repoRoot,
      stdio: "inherit",
    });
  }

  await writeSuperAdminStorageState({ frontend, repoRoot });
}
