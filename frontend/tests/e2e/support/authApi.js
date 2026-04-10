import { routeJson } from "./appMocks";

const defaultUser = {
  id: "admin-1",
  email: "admin@example.com",
  full_name: "Admin User",
  is_staff: true,
  is_superuser: true,
  capabilities: ["admin:full_control", "metadata:edit"],
  totp_setup_required: false,
};

const defaultBooks = [
  {
    id: "book-1",
    slug: "otp-safe-book",
    title: "OTP Safe Book",
    catalog_code: "BK-001",
    writers: [{ id: "writer-1", name: "Writer One" }],
    translators: [],
    editors: [],
    compilers: [],
    series: ["Starter Series"],
    categories: ["Testing"],
    record_type: "digital",
    latest_submission_at: "2026-04-10T12:00:00Z",
    cover_url: "",
  },
];

export async function mockAuthApi(page, options = {}) {
  const user = {
    ...defaultUser,
    ...(options.user || {}),
  };
  const books = options.books || defaultBooks;
  const state = {
    authenticated: Boolean(options.authenticated),
    loginCalls: [],
    passwordResetConfirmCalls: [],
  };

  await page.route("**/api/csrf/", async (route) => {
    await route.fulfill({
      status: 204,
      headers: {
        "set-cookie": "csrftoken=test-csrf-token; Path=/;",
      },
    });
  });

  await page.route("**/api/auth/session/", async (route) => {
    await routeJson(route, {
      authenticated: state.authenticated,
      user: state.authenticated ? user : null,
    });
  });

  await page.route("**/api/auth/login/", async (route) => {
    const payload = route.request().postDataJSON();
    state.loginCalls.push(payload);

    if (!payload?.otp_token) {
      await routeJson(
        route,
        {
          detail: "Enter your authenticator code to continue.",
          code: "otp_required",
        },
        400,
      );
      return;
    }

    state.authenticated = true;
    await routeJson(route, user);
  });

  await page.route("**/api/auth/password-reset/confirm/", async (route) => {
    const payload = route.request().postDataJSON();
    state.passwordResetConfirmCalls.push(payload);
    await routeJson(route, {
      detail: "Password reset complete.",
    });
  });

  await page.route("**/api/catalog/books/**", async (route) => {
    await routeJson(route, books);
  });

  return state;
}
