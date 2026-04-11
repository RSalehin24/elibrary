import { expect } from "./playwright";
import { AuthPageModel } from "../pages/authPage";
import { getSuperAdminCredentials } from "./liveEnv";

export async function loginAsSuperAdmin(page) {
  await page.goto("/home");
  if (page.url().includes("/home")) {
    await expect(
      page.getByRole("heading", { name: "All Books" }),
    ).toBeVisible({ timeout: 15_000 });
    return;
  }

  const authPage = new AuthPageModel(page);
  const credentials = getSuperAdminCredentials();

  await authPage.fillCredentials(credentials);
  await authPage.submitLogin();

  await expect(page).toHaveURL(/\/home/, { timeout: 15_000 });
  await expect(
    page.getByRole("heading", { name: "All Books" }),
  ).toBeVisible({ timeout: 15_000 });
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
