import { defineConfig } from "playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5173";
const useExistingServerOnly = process.env.PLAYWRIGHT_USE_EXISTING_SERVER === "1";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: true,
  use: {
    baseURL,
    trace: "on-first-retry",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
      },
    },
  ],
  ...(useExistingServerOnly
    ? {}
    : {
        webServer: {
          command: "npm run dev -- --host 127.0.0.1",
          url: baseURL,
          reuseExistingServer: true,
          stdout: "ignore",
          stderr: "pipe",
          timeout: 120_000,
        },
      }),
});
