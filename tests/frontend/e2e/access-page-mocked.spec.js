import { expect, test } from "./support/playwright";

function createSessionPayload() {
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

function createManagedUsersPayload(requestUrl, users) {
  const url = new URL(requestUrl);
  const offset = Number(url.searchParams.get("offset") || 0);
  const limit = Number(url.searchParams.get("limit") || 60);
  const rows = users.slice(offset, offset + limit);
  const nextOffset = offset + rows.length;

  return {
    rows,
    pagination: {
      offset,
      limit,
      totalCount: users.length,
      hasMore: nextOffset < users.length,
      nextOffset,
    },
  };
}

function createReferencesPayload(accountScopes, scopedScopes = []) {
  return {
    users: [],
    books: [],
    categories: [],
    writers: [],
    account_scopes: accountScopes,
    scoped_scopes: scopedScopes,
  };
}

test.describe("Access Page Notifications", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("creating an invited user shows a minimal setup-email notification", async ({
    page,
  }) => {
    let resolveCreateRequest;
    const createRequestPromise = new Promise((resolve) => {
      resolveCreateRequest = resolve;
    });
    let usersPayload = [
      {
        id: 1,
        email: "superadmin@example.com",
        full_name: "Super Admin",
        is_active: true,
        is_superuser: true,
        totp_required: false,
        global_scopes: ["admin:access"],
        grant_count: 0,
        can_resend_setup_email: false,
      },
    ];

    await page.route("**/api/auth/session/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createSessionPayload()),
      });
    });
    await page.route("**/api/csrf/", async (route) => {
      await route.fulfill({ status: 204, body: "" });
    });
    await page.route("**/api/auth/users/**", async (route) => {
      if (route.request().method() === "POST") {
        resolveCreateRequest(JSON.parse(route.request().postData() || "{}"));
        usersPayload = [
          ...usersPayload,
          {
            id: 77,
            email: "invited@example.com",
            full_name: "Invited User",
            is_active: true,
            totp_required: true,
            global_scopes: ["read:durable"],
            grant_count: 0,
            can_resend_setup_email: true,
          },
        ];
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            email: "invited@example.com",
            full_name: "Invited User",
            is_active: true,
            totp_required: true,
            global_scopes: ["read:durable"],
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          createManagedUsersPayload(route.request().url(), usersPayload),
        ),
      });
    });
    await page.route("**/api/access/grants/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });
    await page.route("**/api/access/references/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          createReferencesPayload([
            {
              value: "read:durable",
              label: "Read durable books",
            },
          ]),
        ),
      });
    });

    await page.goto("/access");

    const userForm = page.getByTestId("access-user-form");
    await expect(userForm).toBeVisible();

    await userForm.locator('input[placeholder="Full name"]').fill("Invited User");
    await userForm.locator('input[type="email"]').fill("invited@example.com");
    await page.getByRole("checkbox", { name: "Require Two-Factor" }).check();
    await page.getByRole("checkbox", { name: "Read durable books" }).check();
    await userForm.getByRole("button", { name: "Create User" }).click();

    expect(await createRequestPromise).toEqual({
      email: "invited@example.com",
      full_name: "Invited User",
      is_active: true,
      totp_required: true,
      send_invite_email: true,
      global_scopes: ["read:durable"],
    });
    await expect(page.getByText("User created. Setup email sent.")).toBeVisible();
  });

  test("pending invited users show a resend-email action in the users list", async ({
    page,
  }) => {
    const usersPayload = [
      {
        id: 1,
        email: "superadmin@example.com",
        full_name: "Super Admin",
        is_active: true,
        is_superuser: true,
        totp_required: false,
        global_scopes: ["admin:access"],
        grant_count: 0,
        can_resend_setup_email: false,
      },
      {
        id: 77,
        email: "pending@example.com",
        full_name: "Pending User",
        is_active: true,
        is_superuser: false,
        totp_required: true,
        totp_enabled: false,
        global_scopes: ["read:durable"],
        grant_count: 0,
        can_resend_setup_email: true,
      },
    ];

    await page.route("**/api/auth/session/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createSessionPayload()),
      });
    });
    await page.route("**/api/csrf/", async (route) => {
      await route.fulfill({ status: 204, body: "" });
    });
    await page.route("**/api/auth/users/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          createManagedUsersPayload(route.request().url(), usersPayload),
        ),
      });
    });
    await page.route("**/api/access/grants/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });
    await page.route("**/api/access/references/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          createReferencesPayload([
            {
              value: "read:durable",
              label: "Read durable books",
            },
          ]),
        ),
      });
    });

    await page.goto("/access");

    await expect(
      page
        .locator("tr", { hasText: "pending@example.com" })
        .getByRole("button", { name: "Resend Email" }),
    ).toBeVisible();
    await expect(
      page
        .locator("tr", { hasText: "pending@example.com" })
        .getByRole("button", { name: "Edit" }),
    ).toBeVisible();
    await expect(
      page.locator("tr", { hasText: "superadmin@example.com" }).getByText("Locked"),
    ).toBeVisible();
  });

  test("users list fetches the next page while scrolling near the end", async ({
    page,
  }) => {
    const usersPayload = Array.from({ length: 85 }, (_, index) => ({
      id: index + 1,
      email: `paged-user-${index + 1}@example.com`,
      full_name: `Paged User ${index + 1}`,
      is_active: true,
      is_superuser: index === 0,
      totp_required: false,
      totp_enabled: false,
      global_scopes: ["read:durable"],
      grant_count: 0,
      can_resend_setup_email: false,
    }));
    const requestedOffsets = [];

    await page.route("**/api/auth/session/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createSessionPayload()),
      });
    });
    await page.route("**/api/csrf/", async (route) => {
      await route.fulfill({ status: 204, body: "" });
    });
    await page.route("**/api/auth/users/**", async (route) => {
      const url = new URL(route.request().url());
      requestedOffsets.push(Number(url.searchParams.get("offset") || 0));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          createManagedUsersPayload(route.request().url(), usersPayload),
        ),
      });
    });
    await page.route("**/api/access/grants/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });
    await page.route("**/api/access/references/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          createReferencesPayload([
            {
              value: "read:durable",
              label: "Read durable books",
            },
          ]),
        ),
      });
    });

    await page.goto("/access");
    await expect(page.getByTestId("access-users-table")).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(60);

    await page
      .locator('[data-testid="access-users-table"] tbody tr')
      .nth(30)
      .scrollIntoViewIfNeeded();

    await expect
      .poll(() => requestedOffsets.includes(60))
      .toBe(true);
    await expect(page.locator("tbody tr")).toHaveCount(85);
  });

  test("create user form validates the email format before submission", async ({
    page,
  }) => {
    let createRequestCount = 0;

    await page.route("**/api/auth/session/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createSessionPayload()),
      });
    });
    await page.route("**/api/csrf/", async (route) => {
      await route.fulfill({ status: 204, body: "" });
    });
    await page.route("**/api/auth/users/**", async (route) => {
      if (route.request().method() === "POST") {
        createRequestCount += 1;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          createManagedUsersPayload(route.request().url(), [
            {
              id: 1,
              email: "superadmin@example.com",
              full_name: "Super Admin",
              is_active: true,
              is_superuser: true,
              totp_required: false,
              global_scopes: ["admin:access"],
              grant_count: 0,
              can_resend_setup_email: false,
            },
          ]),
        ),
      });
    });
    await page.route("**/api/access/grants/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });
    await page.route("**/api/access/references/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          createReferencesPayload([
            {
              value: "read:durable",
              label: "Read durable books",
            },
          ]),
        ),
      });
    });

    await page.goto("/access");

    const userForm = page.getByTestId("access-user-form");
    const createButton = userForm.getByRole("button", { name: "Create User" });

    await userForm.locator('input[placeholder="Full name"]').fill("Direct User");
    await userForm.locator('input[type="email"]').fill("invalid-email");
    await page.getByRole("checkbox", { name: "Read durable books" }).check();

    await expect(page.locator(".login-email-feedback-invalid")).toBeVisible();
    await expect(page.getByText("Enter a valid email address.")).toBeVisible();
    await expect(createButton).toBeDisabled();
    expect(createRequestCount).toBe(0);
  });

  test("creating a direct-password user shows a labeled validation notification", async ({
    page,
  }) => {
    await page.route("**/api/auth/session/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createSessionPayload()),
      });
    });
    await page.route("**/api/csrf/", async (route) => {
      await route.fulfill({ status: 204, body: "" });
    });
    await page.route("**/api/auth/users/**", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            password: ["Ensure this field has at least 12 characters."],
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          createManagedUsersPayload(route.request().url(), [
            {
              id: 1,
              email: "superadmin@example.com",
              full_name: "Super Admin",
              is_active: true,
              is_superuser: true,
              totp_required: false,
              global_scopes: ["admin:access"],
              grant_count: 0,
              can_resend_setup_email: false,
            },
          ]),
        ),
      });
    });
    await page.route("**/api/access/grants/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });
    await page.route("**/api/access/references/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          createReferencesPayload([
            {
              value: "read:durable",
              label: "Read durable books",
            },
          ]),
        ),
      });
    });

    await page.goto("/access");

    const userForm = page.getByTestId("access-user-form");
    await userForm.locator('input[placeholder="Full name"]').fill("Direct User");
    await userForm.locator('input[type="email"]').fill("direct@example.com");
    await page.getByRole("checkbox", { name: /Send Setup Email/ }).uncheck();
    await userForm.locator('input[placeholder="Create password"]').fill("short");
    await page.getByRole("checkbox", { name: "Read durable books" }).check();
    await userForm.getByRole("button", { name: "Create User" }).click();

    const errorToast = page.getByRole("alert");
    await expect(errorToast.getByText("Something went wrong")).toBeVisible();
    await expect(
      errorToast.getByText("Password: Ensure this field has at least 12 characters."),
    ).toBeVisible();
  });

  test("users list renders each account permission as a separate chip", async ({
    page,
  }) => {
    await page.route("**/api/auth/session/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(createSessionPayload()),
      });
    });
    await page.route("**/api/csrf/", async (route) => {
      await route.fulfill({ status: 204, body: "" });
    });
    await page.route("**/api/auth/users/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          createManagedUsersPayload(route.request().url(), [
            {
              id: 1,
              email: "superadmin@example.com",
              full_name: "Super Admin",
              is_active: true,
              is_superuser: true,
              totp_required: false,
              global_scopes: ["admin:access"],
              grant_count: 0,
              can_resend_setup_email: false,
            },
            {
              id: 77,
              email: "permissions@example.com",
              full_name: "Permission User",
              is_active: true,
              is_superuser: false,
              totp_required: false,
              global_scopes: ["metadata:edit", "read:durable"],
              grant_count: 0,
              can_resend_setup_email: false,
            },
          ]),
        ),
      });
    });
    await page.route("**/api/access/grants/", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });
    await page.route("**/api/access/references/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          createReferencesPayload([
            {
              value: "read:durable",
              label: "Read durable books",
            },
            {
              value: "metadata:edit",
              label: "Edit metadata",
            },
          ]),
        ),
      });
    });

    await page.goto("/access");

    const permissionRow = page.locator("tr", {
      has: page.getByText("permissions@example.com"),
    });
    const chips = permissionRow.locator(".access-permission-chip");

    await expect(chips).toHaveCount(2);
    await expect(permissionRow.getByText("Edit metadata")).toBeVisible();
    await expect(permissionRow.getByText("Read durable books")).toBeVisible();
  });
});
