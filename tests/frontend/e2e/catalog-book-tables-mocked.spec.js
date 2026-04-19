import { expect, test } from "./support/playwright";

const sessionPayload = {
  authenticated: true,
  user: {
    id: 1,
    email: "catalog-admin@example.com",
    full_name: "Catalog Admin",
    is_active: true,
    is_staff: true,
    is_superuser: true,
    capabilities: [],
    totp_enabled: false,
    totp_required: false,
    totp_setup_required: false,
  },
};

const pageVariants = [
  { path: "/library", heading: "Books", view: "table" },
  { path: "/home", heading: "All Books", view: "cards" },
  { path: "/created-books", heading: "My Books", view: "cards" },
];

function createDeferred() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function createBook(index) {
  const bookNumber = String(index + 1).padStart(3, "0");
  return {
    id: `book-${bookNumber}`,
    slug: `catalog-book-${bookNumber}`,
    catalog_code: `BK-${bookNumber}`,
    title: `Catalog Book ${bookNumber}`,
    authors: [`Writer ${bookNumber}`],
    categories: [`Category ${index % 4}`],
    series: index % 2 === 0 ? [`Series ${index % 3}`] : [],
    record_type: index % 5 === 0 ? "manual" : "digital",
    created_at: `2026-04-${String((index % 28) + 1).padStart(2, "0")}T08:00:00Z`,
    primary_source: {
      display_path: `source/${bookNumber}`,
    },
  };
}

async function mockAuthenticatedSession(page) {
  await page.route("**/api/auth/session/", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(sessionPayload),
    });
  });
  await page.route("**/api/csrf/", async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });
}

async function mockCatalogBooksApi(page, total = 75) {
  const books = Array.from({ length: total }, (_, index) => createBook(index));
  const pageTwoRequest = createDeferred();
  const requestLog = [];

  await page.route("**/api/catalog/books/**", async (route) => {
    const url = new URL(route.request().url());
    const currentPage = Number(url.searchParams.get("page") || "1");
    const limit = Number(url.searchParams.get("limit") || "60");
    const query = String(url.searchParams.get("q") || "").trim().toLowerCase();
    const filteredBooks = query
      ? books.filter((book) => book.title.toLowerCase().includes(query))
      : books;

    requestLog.push({
      page: currentPage,
      limit,
      sort: url.searchParams.get("sort") || "",
    });

    if (currentPage === 2) {
      await pageTwoRequest.promise;
    }

    const startIndex = (currentPage - 1) * limit;
    const entries = filteredBooks.slice(startIndex, startIndex + limit);

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        entries,
        pagination: {
          page: currentPage,
          limit,
          total_count: filteredBooks.length,
          page_count: Math.max(1, Math.ceil(filteredBooks.length / limit)),
          has_previous: currentPage > 1,
          has_next: startIndex + entries.length < filteredBooks.length,
        },
      }),
    });
  });

  await page.route("**/api/saved-filters/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  return {
    releasePageTwo: pageTwoRequest.release,
    requestLog,
  };
}

for (const pageVariant of pageVariants) {
  test(`${pageVariant.heading} uses shared inline controls and incremental loading`, async ({
    page,
  }) => {
    await mockAuthenticatedSession(page);
    const { releasePageTwo, requestLog } = await mockCatalogBooksApi(page);

    await page.goto(pageVariant.path);
    await expect(
      page.getByRole("heading", { name: pageVariant.heading, exact: true }),
    ).toBeVisible();
    await expect(page.locator(".catalog-result-count")).toHaveText("75");

    const actionClasses = await page
      .locator(".catalog-search-actions > *")
      .evaluateAll((nodes) => nodes.map((node) => node.className));
    expect(actionClasses[0]).toContain("catalog-search-sort");
    expect(actionClasses[1]).toContain("catalog-filter-toggle");
    expect(actionClasses[2]).toContain("catalog-result-count");
    expect(requestLog[0].page).toBe(1);
    expect(requestLog[0].limit).toBe(60);

    if (pageVariant.view === "table") {
      await expect(page.locator(".book-table tbody tr")).toHaveCount(60);
      await page.locator(".book-table tbody tr").nth(30).scrollIntoViewIfNeeded();
      await expect(page.getByTestId("book-table-load-more-skeleton")).toBeVisible();
    } else {
      await expect(
        page.locator(".book-card:not(.book-card-skeleton)"),
      ).toHaveCount(60);
      await page
        .locator(".book-card:not(.book-card-skeleton)")
        .nth(30)
        .scrollIntoViewIfNeeded();
      await expect(page.getByTestId("book-grid-load-more-skeleton")).toBeVisible();
    }

    releasePageTwo();

    if (pageVariant.view === "table") {
      await expect(page.locator(".book-table tbody tr")).toHaveCount(75);
    } else {
      await expect(
        page.locator(".book-card:not(.book-card-skeleton)"),
      ).toHaveCount(75);
    }
    expect(requestLog.some((entry) => entry.page === 2 && entry.limit === 60)).toBe(
      true,
    );
  });
}
