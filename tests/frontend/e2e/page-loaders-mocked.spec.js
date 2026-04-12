import { expect, test } from "./support/playwright";

function createDeferred() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function authenticatedSessionPayload() {
  return {
    authenticated: true,
    user: {
      id: 1,
      email: "superadmin@example.com",
      full_name: "Super Admin",
      profile_image_url: "",
      is_active: true,
      is_staff: true,
      is_superuser: true,
      totp_enabled: false,
      totp_required: false,
      totp_setup_required: false,
      capabilities: [],
    },
  };
}

function unauthenticatedSessionPayload() {
  return {
    authenticated: false,
    user: null,
  };
}

test.describe("Page Loader Skeletons", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("catalog pages show a table skeleton while list data is loading", async ({
    page,
  }) => {
    const categoriesRequest = createDeferred();

    await page.route("**/api/auth/session/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(authenticatedSessionPayload()),
      });
    });
    await page.route("**/api/csrf/", async (route) => {
      await route.fulfill({ status: 204, body: "" });
    });
    await page.route("**/api/catalog/categories/**", async (route) => {
      await categoriesRequest.promise;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });

    await page.goto("/categories");
    await expect(page.locator(".page-loader-variant-table")).toBeVisible();

    categoriesRequest.release();
    await expect(page.getByRole("heading", { name: "Categories" })).toBeVisible();
    await expect(page.locator(".page-loader-variant-table")).toHaveCount(0);
  });

  test("admin pages show a management skeleton while admin data is loading", async ({
    page,
  }) => {
    const adminDataRequest = createDeferred();

    await page.route("**/api/auth/session/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(authenticatedSessionPayload()),
      });
    });
    await page.route("**/api/csrf/", async (route) => {
      await route.fulfill({ status: 204, body: "" });
    });
    await page.route("**/api/auth/users/", async (route) => {
      await adminDataRequest.promise;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });
    await page.route("**/api/access/grants/", async (route) => {
      await adminDataRequest.promise;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });
    await page.route("**/api/access/references/", async (route) => {
      await adminDataRequest.promise;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          books: [],
          categories: [],
          writers: [],
          account_scopes: [],
          scoped_scopes: [],
        }),
      });
    });

    await page.goto("/access");
    await expect(page.locator(".page-loader-variant-management")).toBeVisible();

    adminDataRequest.release();
    await expect(
      page.getByRole("heading", { name: "Users & Access" }),
    ).toBeVisible();
    await expect(page.locator(".page-loader-variant-management")).toHaveCount(0);
  });

  test("auth pages show an auth skeleton while session state is loading", async ({
    page,
  }) => {
    const sessionRequest = createDeferred();

    await page.route("**/api/auth/session/", async (route) => {
      await sessionRequest.promise;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(unauthenticatedSessionPayload()),
      });
    });
    await page.route("**/api/csrf/", async (route) => {
      await route.fulfill({ status: 204, body: "" });
    });
    await page.route("**/api/auth/password-reset/validate/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          detail: "Password link is valid.",
        }),
      });
    });

    await page.goto("/create-password?uid=loader-uid&token=loader-token");
    await expect(page.locator(".page-loader-variant-auth")).toBeVisible();

    sessionRequest.release();
    await expect(
      page.getByRole("heading", { name: "Create password" }),
    ).toBeVisible();
    await expect(page.locator(".page-loader-variant-auth")).toHaveCount(0);
  });
});
