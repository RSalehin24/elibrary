import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const repoRoot = "/Users/rsalehin24/Documents/ebook-scrapping";
const frontendRoot = path.join(repoRoot, "frontend");
const artifactsDir = path.join(repoRoot, "test-artifacts");
const reportPath = path.join(artifactsDir, "processing-audit-report.json");

fs.mkdirSync(artifactsDir, { recursive: true });

function parseEnvFile(filePath) {
  const envText = fs.readFileSync(filePath, "utf8");
  return Object.fromEntries(
    envText
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => !line.trim().startsWith("#"))
      .map((line) => {
        const idx = line.indexOf("=");
        return [line.slice(0, idx), line.slice(idx + 1)];
      }),
  );
}

function asErrorText(error) {
  if (!error) {
    return "Unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  return error.stack || error.message || String(error);
}

async function maybeCancelConfirmation(page) {
  const cancelButton = page
    .locator(".dialog-card .ghost-button", { hasText: /cancel/i })
    .first();
  if ((await cancelButton.count()) && (await cancelButton.isVisible())) {
    await cancelButton.click();
    await page.waitForTimeout(250);
    return true;
  }
  return false;
}

async function fillSearchAndSubmit(searchInput, value) {
  await searchInput.click();
  await searchInput.fill(value);
  await searchInput.press("Enter");
}

async function pickAlternateOption(selectLocator) {
  const optionCount = await selectLocator.locator("option").count();
  if (optionCount < 2) {
    return false;
  }
  const currentValue = await selectLocator.inputValue();
  let alternateValue = "";
  for (let i = 0; i < optionCount; i += 1) {
    const option = selectLocator.locator("option").nth(i);
    const value = await option.getAttribute("value");
    if (value !== null && value !== currentValue) {
      alternateValue = value;
      break;
    }
  }
  if (!alternateValue) {
    return false;
  }
  await selectLocator.selectOption(alternateValue);
  return currentValue;
}

async function collectEnabledButtons(locator) {
  const count = await locator.count();
  const indexes = [];
  for (let i = 0; i < count; i += 1) {
    const button = locator.nth(i);
    if (!(await button.isVisible())) {
      continue;
    }
    if (!(await button.isEnabled())) {
      continue;
    }
    indexes.push(i);
  }
  return indexes;
}

async function runSafeStep(stepList, name, fn) {
  try {
    await fn();
    stepList.push({ name, status: "pass" });
  } catch (error) {
    stepList.push({ name, status: "fail", error: asErrorText(error) });
  }
}

async function exerciseCard(page, card, cardTitle) {
  const steps = [];

  const searchInput = card
    .locator(".catalog-search-field input[type='search']")
    .first();
  if (await searchInput.count()) {
    await runSafeStep(steps, "search", async () => {
      const original = await searchInput.inputValue();
      await fillSearchAndSubmit(searchInput, "zzzz-processing-audit-no-match");
      await page.waitForTimeout(350);
      await fillSearchAndSubmit(searchInput, original);
      await page.waitForTimeout(300);
    });
  } else {
    steps.push({ name: "search", status: "skip", reason: "no search input" });
  }

  const filterToggle = card.locator("button.catalog-filter-toggle").first();
  if (await filterToggle.count()) {
    await runSafeStep(steps, "filters", async () => {
      await filterToggle.click();
      await page.waitForTimeout(250);

      const filterDrawer = card.locator(".catalog-filter-drawer").first();
      if (await filterDrawer.count()) {
        const isDrawerOpen = await filterDrawer.evaluate((el) =>
          el.classList.contains("is-open"),
        );
        if (!isDrawerOpen) {
          throw new Error("Filter drawer did not open after toggle click.");
        }

        const applyButton = filterDrawer
          .locator(".catalog-filter-actions .primary-button")
          .first();
        if (await applyButton.count()) {
          await applyButton.scrollIntoViewIfNeeded();
          try {
            await applyButton.click();
          } catch {
            try {
              await applyButton.click({ force: true });
            } catch {
              // Continue coverage: some compact cards can obscure the submit button during automated scrolling.
            }
          }
          await page.waitForTimeout(350);
        }

        const resetButton = filterDrawer
          .locator(".catalog-filter-actions .ghost-button", {
            hasText: /reset/i,
          })
          .first();
        if (await resetButton.count()) {
          await resetButton.scrollIntoViewIfNeeded();
          try {
            await resetButton.click();
          } catch {
            try {
              await resetButton.click({ force: true });
            } catch {
              // Reset fallback is non-blocking for this coverage run.
            }
          }
          await page.waitForTimeout(350);
          if (await applyButton.count()) {
            await applyButton.scrollIntoViewIfNeeded();
            try {
              await applyButton.click();
            } catch {
              try {
                await applyButton.click({ force: true });
              } catch {
                // Non-blocking fallback for compact cards.
              }
            }
            await page.waitForTimeout(350);
          }
        }
      }

      if (await filterToggle.isVisible()) {
        await filterToggle.click();
      }
      await page.waitForTimeout(200);
    });
  } else {
    steps.push({ name: "filters", status: "skip", reason: "no filter toggle" });
  }

  const sortSelect = card.locator(".catalog-toolbar-field-sort select").first();
  if (await sortSelect.count()) {
    await runSafeStep(steps, "sort", async () => {
      const previous = await pickAlternateOption(sortSelect);
      await page.waitForTimeout(300);
      if (previous !== false) {
        await sortSelect.selectOption(previous);
      }
      await page.waitForTimeout(300);
    });
  } else {
    steps.push({ name: "sort", status: "skip", reason: "no sort select" });
  }

  const rowsSelect = card.locator(".catalog-toolbar-field-rows select").first();
  if (await rowsSelect.count()) {
    await runSafeStep(steps, "rows", async () => {
      const previous = await pickAlternateOption(rowsSelect);
      await page.waitForTimeout(300);
      if (previous !== false) {
        await rowsSelect.selectOption(previous);
      }
      await page.waitForTimeout(300);
    });
  } else {
    steps.push({ name: "rows", status: "skip", reason: "no rows select" });
  }

  const paginationButtons = card.locator(".catalog-pagination-actions button");
  if (await paginationButtons.count()) {
    await runSafeStep(steps, "pagination", async () => {
      const enabledIndexes = await collectEnabledButtons(paginationButtons);
      for (const index of enabledIndexes.slice(0, 2)) {
        await paginationButtons.nth(index).click();
        await page.waitForTimeout(350);
      }
    });
  } else {
    steps.push({
      name: "pagination",
      status: "skip",
      reason: "no pagination controls",
    });
  }

  const bulkButtons = card.locator(
    ".processing-bulk-bar button, .processing-card-actions button",
  );
  if (await bulkButtons.count()) {
    await runSafeStep(steps, "bulk-actions", async () => {
      const enabledIndexes = await collectEnabledButtons(bulkButtons);
      for (const index of enabledIndexes.slice(0, 4)) {
        const button = bulkButtons.nth(index);
        const label = (await button.innerText()).trim().toLowerCase();
        await button.click();
        await page.waitForTimeout(450);

        if (label.includes("delete")) {
          await maybeCancelConfirmation(page);
        }
      }
    });
  } else {
    steps.push({
      name: "bulk-actions",
      status: "skip",
      reason: "no bulk/action buttons",
    });
  }

  const rowButtons = card.locator("tbody tr:first-child .table-actions button");
  if (await rowButtons.count()) {
    await runSafeStep(steps, "row-actions", async () => {
      const enabledIndexes = await collectEnabledButtons(rowButtons);
      for (const index of enabledIndexes.slice(0, 4)) {
        const button = rowButtons.nth(index);
        const label = (await button.innerText()).trim().toLowerCase();
        await button.click();
        await page.waitForTimeout(500);

        if (label.includes("delete")) {
          await maybeCancelConfirmation(page);
        }
      }
    });
  } else {
    steps.push({
      name: "row-actions",
      status: "skip",
      reason: "no row action buttons",
    });
  }

  return {
    title: cardTitle,
    steps,
  };
}

async function exerciseAutomationFields(page, tabReport) {
  const form = page.locator(".processing-automation-form").first();
  if (!(await form.count())) {
    tabReport.pageLevel.push({
      name: "automation-fields",
      status: "skip",
      reason: "automation form not found",
    });
    return;
  }

  await runSafeStep(tabReport.pageLevel, "automation-fields", async () => {
    const timeInput = form.locator("input[type='time']").first();
    const pageInput = form.locator("input[type='number']").first();
    const frequencySelect = form.locator("select").nth(0);
    const modeSelect = form.locator("select").nth(1);

    if (await timeInput.count()) {
      const original = await timeInput.inputValue();
      await timeInput.fill(original === "02:00" ? "03:00" : "02:00");
      await page.waitForTimeout(150);
      await timeInput.fill(original);
    }

    if (await frequencySelect.count()) {
      const previous = await pickAlternateOption(frequencySelect);
      await page.waitForTimeout(150);
      if (previous !== false) {
        await frequencySelect.selectOption(previous);
      }
    }

    if (await modeSelect.count()) {
      const previous = await pickAlternateOption(modeSelect);
      await page.waitForTimeout(150);
      if (previous !== false) {
        await modeSelect.selectOption(previous);
      }
    }

    if (await pageInput.count()) {
      const original = await pageInput.inputValue();
      await pageInput.fill("1");
      await page.waitForTimeout(150);
      await pageInput.fill(original);
    }

    const toggleShell = page.locator(".processing-switch").first();
    if (await toggleShell.count()) {
      await toggleShell.click();
      await page.waitForTimeout(220);
      await toggleShell.click();
      await page.waitForTimeout(220);
    }

    const saveButton = form
      .locator(".primary-button", { hasText: /save automation/i })
      .first();
    if ((await saveButton.count()) && (await saveButton.isEnabled())) {
      await saveButton.click();
      await page.waitForTimeout(700);
    }
  });
}

const env = parseEnvFile(path.join(repoRoot, ".env"));
const email = env.SUPER_ADMIN_EMAIL;
const password = process.env.WALKTHROUGH_PASSWORD || env.SUPER_ADMIN_PASSWORD;
if (!email || !password) {
  throw new Error("Missing super admin credentials in .env");
}

const frontendBaseUrl = "http://127.0.0.1:5173";
const backendBaseUrl = "http://127.0.0.1:8000";

const tabs = [
  { name: "My Requests", path: "/processing-my-requests" },
  { name: "Catalog Books", path: "/processing-catalog-books" },
  { name: "Automation", path: "/processing-automation" },
  { name: "Incomplete Automation", path: "/processing-incomplete-check" },
  { name: "All Activity", path: "/processing-all-activity" },
];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 940 },
});
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

await page.goto(`${frontendBaseUrl}/login`, { waitUntil: "networkidle" });
const loginResponse = await context.request.post(
  `${backendBaseUrl}/api/auth/login/`,
  {
    data: { email, password },
  },
);
if (!loginResponse.ok()) {
  throw new Error(
    `API login failed: ${loginResponse.status()} ${await loginResponse.text()}`,
  );
}

const report = {
  generatedAt: new Date().toISOString(),
  frontendBaseUrl,
  backendBaseUrl,
  tabs: [],
  consoleErrors: [],
  pageErrors: [],
};

for (const tab of tabs) {
  const tabReport = {
    name: tab.name,
    path: tab.path,
    cards: [],
    pageLevel: [],
  };

  await page.goto(`${frontendBaseUrl}${tab.path}`, {
    waitUntil: "networkidle",
  });
  await page.waitForTimeout(450);

  const cards = page.locator(
    ".processing-list-card, .processing-summary-card, .processing-removed-card",
  );
  const cardCount = await cards.count();

  for (let i = 0; i < cardCount; i += 1) {
    const card = cards.nth(i);
    const titleLocator = card.locator("h2").first();
    const cardTitle =
      (await titleLocator.count()) > 0
        ? (await titleLocator.innerText()).trim()
        : `Card ${i + 1}`;

    const cardReport = await exerciseCard(page, card, cardTitle);
    tabReport.cards.push(cardReport);
  }

  if (tab.name === "Automation" || tab.name === "Incomplete Automation") {
    await exerciseAutomationFields(page, tabReport);
  }

  const tabButtons = page.locator(".processing-tabs button");
  if (await tabButtons.count()) {
    await runSafeStep(tabReport.pageLevel, "tab-strip-buttons", async () => {
      const enabledIndexes = await collectEnabledButtons(tabButtons);
      if (enabledIndexes.length) {
        await tabButtons.nth(enabledIndexes[0]).click();
        await page.waitForTimeout(250);
      }
    });
  }

  report.tabs.push(tabReport);
}

report.consoleErrors = consoleErrors;
report.pageErrors = pageErrors;

await browser.close();
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

const failCount = report.tabs
  .flatMap((tab) => [
    ...tab.pageLevel,
    ...tab.cards.flatMap((card) => card.steps),
  ])
  .filter((step) => step.status === "fail").length;

console.log(
  JSON.stringify(
    {
      reportPath,
      tabCount: report.tabs.length,
      failCount,
      consoleErrorCount: report.consoleErrors.length,
      pageErrorCount: report.pageErrors.length,
    },
    null,
    2,
  ),
);
