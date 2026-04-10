import { routeJson } from "./appMocks";

function parseJsonBody(route) {
  const body = route.request().postData() || "{}";
  return JSON.parse(body);
}

export async function mockAccessApi(page, currentUserId = "admin-1") {
  const state = {
    deletedUsers: [],
    grantCreateCalls: [],
    userUpdateCalls: [],
    users: [
      {
        id: currentUserId,
        email: "admin@example.com",
        full_name: "Admin User",
        is_active: true,
        totp_required: false,
        totp_enabled: true,
        is_superuser: true,
        global_scopes: ["admin:full_control"],
      },
      {
        id: "user-2",
        email: "writer@example.com",
        full_name: "Writer User",
        is_active: true,
        totp_required: false,
        totp_enabled: false,
        is_superuser: false,
        global_scopes: ["metadata:edit"],
      },
      {
        id: "user-3",
        email: "disabled@example.com",
        full_name: "Disabled User",
        is_active: false,
        totp_required: true,
        totp_enabled: false,
        is_superuser: false,
        global_scopes: ["catalog:view"],
      },
    ],
    grants: [
      {
        id: "grant-1",
        user: "user-2",
        user_email: "writer@example.com",
        scope: "metadata:edit",
        book: "book-1",
        category: null,
        contributor: null,
        target_label: "Book One",
      },
    ],
    references: {
      books: [
        { id: "book-1", title: "Book One", slug: "book-one" },
        { id: "book-2", title: "Book Two", slug: "book-two" },
      ],
      categories: [{ id: "category-1", name: "Poetry", slug: "poetry" }],
      writers: [{ id: "writer-1", name: "Writer One", slug: "writer-one" }],
      account_scopes: [
        { value: "catalog:view", label: "Catalog View" },
        { value: "metadata:edit", label: "Metadata Edit" },
      ],
      scoped_scopes: [{ value: "metadata:edit", label: "Metadata Edit" }],
    },
  };

  await page.route("**/api/auth/users/", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await routeJson(route, state.users);
      return;
    }

    const payload = parseJsonBody(route);
    const createdUser = {
      id: `user-${state.users.length + 1}`,
      email: payload.email,
      full_name: payload.full_name,
      is_active: payload.is_active,
      totp_required: payload.totp_required,
      totp_enabled: false,
      is_superuser: false,
      global_scopes: payload.global_scopes || [],
    };
    state.users.push(createdUser);
    await routeJson(route, createdUser, 201);
  });

  await page.route(/.*\/api\/auth\/users\/[^/]+\/$/, async (route) => {
    const request = route.request();
    const userId = request.url().split("/").filter(Boolean).at(-1);

    if (request.method() === "PATCH") {
      const payload = parseJsonBody(route);
      state.userUpdateCalls.push({ userId, payload });
      state.users = state.users.map((entry) =>
        entry.id === userId ? { ...entry, ...payload } : entry,
      );
      await routeJson(
        route,
        state.users.find((entry) => entry.id === userId),
      );
      return;
    }

    state.deletedUsers.push(userId);
    state.users = state.users.filter((entry) => entry.id !== userId);
    await route.fulfill({ status: 204 });
  });

  await page.route("**/api/access/grants/", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await routeJson(route, state.grants);
      return;
    }

    const payload = parseJsonBody(route);
    state.grantCreateCalls.push(payload);
    const createdGrant = {
      id: `grant-${state.grants.length + 1}`,
      user: payload.user,
      user_email:
        state.users.find((entry) => `${entry.id}` === `${payload.user}`)?.email ||
        "unknown@example.com",
      scope: payload.scope,
      book: payload.book || null,
      category: payload.category || null,
      contributor: payload.contributor || null,
      target_label:
        state.references.books.find((entry) => `${entry.id}` === `${payload.book}`)?.title ||
        state.references.categories.find(
          (entry) => `${entry.id}` === `${payload.category}`,
        )?.name ||
        state.references.writers.find(
          (entry) => `${entry.id}` === `${payload.contributor}`,
        )?.name ||
        "",
    };
    state.grants.push(createdGrant);
    await routeJson(route, createdGrant, 201);
  });

  await page.route(/.*\/api\/access\/grants\/[^/]+\/$/, async (route) => {
    const grantId = route.request().url().split("/").filter(Boolean).at(-1);
    state.grants = state.grants.filter((entry) => entry.id !== grantId);
    await route.fulfill({ status: 204 });
  });

  await page.route("**/api/access/references/", async (route) => {
    await routeJson(route, state.references);
  });

  return state;
}
