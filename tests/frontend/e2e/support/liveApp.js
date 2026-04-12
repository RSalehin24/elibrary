import { fileURLToPath } from "node:url";
import { expect } from "./playwright";
import { AuthPageModel } from "../pages/authPage";
import { getSuperAdminCredentials } from "./liveEnv";

const LIVE_STORAGE_STATE_PATH = fileURLToPath(
  new URL("../../.auth/superadmin.json", import.meta.url),
);

async function waitForHomeOrLogin(page, timeout = 15_000) {
  const homeHeading = page.getByRole("heading", { name: "All Books" });
  const loginHeading = page.getByRole("heading", { name: "Sign in" });

  const visibleState = await Promise.race([
    homeHeading
      .waitFor({ state: "visible", timeout })
      .then(() => "home")
      .catch(() => null),
    loginHeading
      .waitFor({ state: "visible", timeout })
      .then(() => "login")
      .catch(() => null),
  ]);

  if (!visibleState) {
    throw new Error("Unable to determine whether the app is on home or sign in.");
  }

  return visibleState;
}

async function persistLiveStorageState(page) {
  await page.context().storageState({ path: LIVE_STORAGE_STATE_PATH });
}

export async function loginAsSuperAdmin(page) {
  await page.goto("/home");

  if ((await waitForHomeOrLogin(page)) === "home") {
    await persistLiveStorageState(page);
    return;
  }

  const authPage = new AuthPageModel(page);
  const credentials = getSuperAdminCredentials();
  await authPage.fillCredentials(credentials);
  await authPage.submitLogin();

  await page.goto("/home");
  await expect(
    page.getByRole("heading", { name: "All Books" }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(page).toHaveURL(/\/home/, { timeout: 15_000 });
  await persistLiveStorageState(page);
}

export async function installWindowOpenRecorder(page) {
  await page.addInitScript(() => {
    window.__openedUrls = [];
    window.open = (url) => {
      window.__openedUrls.push(String(url));
      return {
        closed: false,
        focus() {},
        location: {
          href: String(url),
          replace(nextUrl) {
            this.href = String(nextUrl);
          },
        },
      };
    };
  });
}

export async function readOpenedUrls(page) {
  return page.evaluate(() => window.__openedUrls || []);
}
