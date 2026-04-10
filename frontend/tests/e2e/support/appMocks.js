export function routeJson(route, payload, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

export async function installApiGuard(page) {
  await page.route(/https?:\/\/[^/]+\/api\/.*/, async (route) => {
    throw new Error(
      `Unhandled API request: ${route.request().method()} ${route.request().url()}`,
    );
  });
}

export async function mockAuthenticatedSession(page, userOverrides = {}) {
  const user = {
    id: "admin-1",
    email: "admin@example.com",
    full_name: "Admin User",
    is_staff: true,
    is_superuser: true,
    capabilities: ["admin:full_control", "metadata:edit"],
    totp_setup_required: false,
    ...userOverrides,
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
      authenticated: true,
      user,
    });
  });

  return user;
}

export async function installWindowOpenRecorder(page) {
  await page.addInitScript(() => {
    const openedUrls = [];
    window.__openedUrls = openedUrls;
    window.open = (...args) => {
      const initialUrl = String(args[0] || "");
      if (initialUrl) {
        openedUrls.push(initialUrl);
      }
      return {
        closed: false,
        focus() {},
        location: {
          href: initialUrl,
          replace(nextUrl) {
            const normalizedUrl = String(nextUrl || "");
            this.href = normalizedUrl;
            if (normalizedUrl) {
              openedUrls.push(normalizedUrl);
            }
          },
        },
      };
    };
  });
}

export async function readOpenedUrls(page) {
  return page.evaluate(() => window.__openedUrls || []);
}
