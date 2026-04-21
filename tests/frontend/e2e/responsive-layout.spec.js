import { expect, test } from "./support/playwright";
import { loginAsSuperAdmin } from "./support/liveApp";
import { seedData } from "./support/seedData";

function createSessionPayload(overrides = {}) {
  return {
    authenticated: true,
    user: {
      id: 1,
      email: "responsive-admin@example.com",
      full_name: "Responsive Admin",
      profile_image_url: "",
      is_active: true,
      is_staff: true,
      is_superuser: true,
      capabilities: ["processing:manage"],
      totp_enabled: false,
      totp_required: false,
      totp_setup_required: false,
      ...overrides,
    },
  };
}

function createBook(index, overrides = {}) {
  const bookNumber = String(index + 1).padStart(3, "0");
  return {
    id: `book-${bookNumber}`,
    slug: `responsive-book-${bookNumber}`,
    catalog_code: `BK-${bookNumber}`,
    title: `Responsive Book ${bookNumber}`,
    authors: [`Writer ${bookNumber}`],
    categories: [`Category ${index % 4}`],
    series: index % 2 === 0 ? [`Series ${index % 3}`] : [],
    record_type: index % 5 === 0 ? "manual" : "digital",
    created_at: `2026-04-${String((index % 28) + 1).padStart(2, "0")}T08:00:00Z`,
    latest_submission_at: `2026-04-${String((index % 28) + 1).padStart(2, "0")}T09:00:00Z`,
    primary_source: {
      display_path: `source/${bookNumber}`,
    },
    ...overrides,
  };
}

async function mockAuthenticatedSession(page, userOverrides = {}) {
  await page.route("**/api/auth/session/", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createSessionPayload(userOverrides)),
    });
  });
  await page.route("**/api/csrf/", async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });
}

async function mockCatalogBooksApi(page, total = 24, options = {}) {
  const books = Array.from({ length: total }, (_, index) => createBook(index));
  const { savedFilters = [] } = options;

  await page.route("**/api/catalog/books/**", async (route) => {
    const url = new URL(route.request().url());
    const currentPage = Number(url.searchParams.get("page") || "1");
    const limit = Number(url.searchParams.get("limit") || "60");
    const startIndex = (currentPage - 1) * limit;
    const entries = books.slice(startIndex, startIndex + limit);

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        entries,
        pagination: {
          page: currentPage,
          limit,
          total_count: books.length,
          page_count: Math.max(1, Math.ceil(books.length / limit)),
          has_previous: currentPage > 1,
          has_next: startIndex + entries.length < books.length,
        },
      }),
    });
  });

  await page.route("**/api/saved-filters/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(savedFilters),
    });
  });
}

async function mockAccessApi(page, totalUsers = 2) {
  const users = [
    {
      id: 1,
      email: "responsive-admin@example.com",
      full_name: "Responsive Admin",
      is_active: true,
      is_superuser: true,
      totp_required: false,
      totp_enabled: true,
      global_scopes: ["admin:access"],
      grant_count: 0,
      can_resend_setup_email: false,
    },
    ...Array.from({ length: Math.max(totalUsers - 1, 1) }, (_, index) => ({
      id: 77 + index,
      email: `pending-user-${index + 1}@example.com`,
      full_name: `Pending User ${index + 1}`,
      is_active: index % 4 !== 0,
      is_superuser: false,
      totp_required: index % 2 === 0,
      totp_enabled: index % 2 !== 0,
      global_scopes:
        index % 3 === 0
          ? ["read:durable", "metadata:edit"]
          : ["read:durable"],
      grant_count: (index % 3) + 1,
      can_resend_setup_email: index % 2 === 0,
    })),
  ].slice(0, totalUsers);

  function managedUsersPayload(requestUrl) {
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

  await page.route("**/api/auth/users/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(managedUsersPayload(route.request().url())),
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
      body: JSON.stringify({
        users: [],
        books: [],
        categories: [],
        writers: [],
        account_scopes: [
          { value: "read:durable", label: "Read durable books" },
          { value: "metadata:edit", label: "Edit metadata" },
        ],
        scoped_scopes: [
          { value: "read:durable", label: "Read durable books" },
          { value: "metadata:edit", label: "Edit metadata" },
        ],
      }),
    });
  });
}

async function mockProfileApi(page) {
  const profile = {
    id: 1,
    email: "profile-user@example.com",
    full_name: "Profile User",
    profile_image_url: "",
    kindle_emails: ["reader@kindle.com"],
    kindle_sender_email: "library-sender@example.com",
    is_active: true,
    is_staff: false,
    is_superuser: false,
  };

  await page.route("**/api/auth/profile/", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(profile),
    });
  });
  await page.route("**/api/auth/2fa/status/", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        enabled: false,
        pending_setup: false,
        required: false,
        setup_required: false,
      }),
    });
  });
}

async function mockManualBooksApi(page, total = 8) {
  const books = Array.from({ length: total }, (_, index) =>
    createBook(index, {
      id: `manual-${index + 1}`,
      slug: `manual-book-${index + 1}`,
      catalog_code: `MB-${String(index + 1).padStart(3, "0")}`,
      title: `Manual Book ${index + 1}`,
      record_type: "manual",
    }),
  );

  await page.route("**/api/catalog/manual-books/**", async (route) => {
    const url = new URL(route.request().url());
    const currentPage = Number(url.searchParams.get("page") || "1");
    const limit = Number(url.searchParams.get("limit") || "60");
    const startIndex = (currentPage - 1) * limit;
    const entries = books.slice(startIndex, startIndex + limit);

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        entries,
        pagination: {
          page: currentPage,
          limit,
          total_count: books.length,
          page_count: Math.max(1, Math.ceil(books.length / limit)),
          has_previous: currentPage > 1,
          has_next: startIndex + entries.length < books.length,
        },
      }),
    });
  });

  const suggestionPayloads = {
    categories: [{ name: "Architecture" }, { name: "History" }],
    writers: [{ name: "Ada Writer" }, { name: "Bea Writer" }],
    translators: [{ name: "Sam Translator" }],
    compilers: [{ name: "Casey Compiler" }],
    editors: [{ name: "Evan Editor" }],
  };

  await page.route("**/api/catalog/categories/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(suggestionPayloads.categories),
    });
  });
  await page.route("**/api/catalog/writers/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(suggestionPayloads.writers),
    });
  });
  await page.route("**/api/catalog/translators/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(suggestionPayloads.translators),
    });
  });
  await page.route("**/api/catalog/compilers/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(suggestionPayloads.compilers),
    });
  });
  await page.route("**/api/catalog/editors/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(suggestionPayloads.editors),
    });
  });
}

async function mockPropertyPagesApi(page) {
  const categories = Array.from({ length: 6 }, (_, index) => ({
    id: `category-${index + 1}`,
    catalog_code: `CAT-${String(index + 1).padStart(3, "0")}`,
    name: `Category ${index + 1}`,
    book_count: 20 - index,
    digital_book_count: 15 - index,
    manual_book_count: 5,
    created_at: `2026-04-${String(index + 1).padStart(2, "0")}T08:00:00Z`,
  }));
  const series = Array.from({ length: 6 }, (_, index) => ({
    id: `series-${index + 1}`,
    name: `Series ${index + 1}`,
    book_count: 18 - index,
    digital_book_count: 14 - index,
    manual_book_count: 4,
    created_at: `2026-04-${String(index + 7).padStart(2, "0")}T08:00:00Z`,
  }));
  const contributors = Array.from({ length: 6 }, (_, index) => ({
    id: `contributor-${index + 1}`,
    catalog_code: `WRT-${String(index + 1).padStart(3, "0")}`,
    name: `Contributor ${index + 1}`,
    book_count: 16 - index,
    digital_book_count: 12 - index,
    manual_book_count: 4,
    created_at: `2026-04-${String(index + 13).padStart(2, "0")}T08:00:00Z`,
  }));

  await page.route("**/api/catalog/categories/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(categories),
    });
  });
  await page.route("**/api/catalog/series/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(series),
    });
  });
  await page.route("**/api/catalog/writers/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(contributors),
    });
  });
  await page.route("**/api/catalog/translators/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(contributors),
    });
  });
  await page.route("**/api/catalog/compilers/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(contributors),
    });
  });
  await page.route("**/api/catalog/editors/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(contributors),
    });
  });
}

async function mockProcessingApi(page) {
  await page.addInitScript(() => {
    class MockEventSource {
      constructor() {
        this.listeners = new Map();
        this.onerror = null;
        setTimeout(() => {
          const connected = this.listeners.get("connected") || [];
          connected.forEach((listener) => listener({ data: "{}" }));
        }, 0);
      }

      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        this.listeners.set(
          type,
          listeners.filter((candidate) => candidate !== listener),
        );
      }

      close() {}
    }

    window.EventSource = MockEventSource;
  });

  const rows = [
    {
      id: "record-1",
      recordId: "record-1",
      requestId: null,
      title: "Responsive Processing Record",
      url: "https://example.test/books/responsive-processing-record",
      displayUrl: "example.test/books/responsive-processing-record",
      displayPath: "",
      category: "Architecture",
      writer: "Ada Writer",
      translator: "Sam Translator",
      publisher: "North Press",
      status: "not_created",
      updatedAt: "2026-04-21T08:00:00Z",
      selectable: true,
      progressCheckpoint: "",
      progressSavedAt: "",
      errorMessage: "",
      isResumed: false,
      isConfirmedNotDuplicate: false,
      linkedBookId: null,
      linkedBookSlug: null,
      duplicateOfRequestId: null,
      duplicateOfRecordId: null,
      duplicateConfirmed: false,
    },
    {
      id: "record-2",
      recordId: "record-2",
      requestId: "request-2",
      title: "Queued Processing Record",
      url: "https://example.test/books/queued-processing-record",
      displayUrl: "example.test/books/queued-processing-record",
      displayPath: "",
      category: "History",
      writer: "Bea Writer",
      translator: "",
      publisher: "South Press",
      status: "queued",
      updatedAt: "2026-04-21T09:00:00Z",
      selectable: false,
      progressCheckpoint: "",
      progressSavedAt: "",
      errorMessage: "",
      isResumed: false,
      isConfirmedNotDuplicate: false,
      linkedBookId: null,
      linkedBookSlug: null,
      duplicateOfRequestId: null,
      duplicateOfRecordId: null,
      duplicateConfirmed: false,
    },
  ];

  await page.route("**/api/processing/card/**", async (route) => {
    const url = new URL(route.request().url());
    const card = url.searchParams.get("card") || "";

    const payloads = {
      "catalog-overview": {
        summary: {
          records: 24,
          notCreated: 14,
          active: 6,
          created: 3,
          onHold: 1,
        },
      },
      "catalog-sync": {
        sync: {
          status: "idle",
          runMode: "manual",
          message: "Ready to sync.",
        },
      },
      "catalog-automation": {
        sync: {
          status: "idle",
          runMode: "manual",
          message: "Ready to sync.",
        },
        automation: {
          enabled: false,
          interval: "weekly",
          time: "03:00",
          saved: false,
          lastRunAt: null,
          statusMessage: "",
        },
      },
    };

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payloads[card] || {}),
    });
  });

  await page.route("**/api/processing/table/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        rows,
        pagination: {
          offset: 0,
          limit: 60,
          totalCount: rows.length,
          returnedCount: rows.length,
          hasMore: false,
          nextOffset: rows.length,
        },
        filters: {
          categoryOptions: ["Architecture", "History"],
          statusOptions: ["not_created", "queued"],
        },
      }),
    });
  });
}

async function assertNoPageOverflow(page) {
  const overflow = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.width + 2);
}

async function getGridColumnCount(page, selector) {
  return page.locator(selector).evaluate((node) => {
    const columns = getComputedStyle(node).gridTemplateColumns.trim();
    if (!columns || columns === "none") {
      return 0;
    }
    return columns.split(/\s+/).length;
  });
}

async function expectFirstBookCoverToFillCardWidth(page) {
  const metrics = await page.locator(".book-card").first().evaluate((card) => {
    const art = card.querySelector(".book-card-art");
    const cover = card.querySelector(".book-card-cover");
    const cardStyle = getComputedStyle(card);
    const cardBox = card.getBoundingClientRect();
    const artBox = art.getBoundingClientRect();
    const coverBox = cover.getBoundingClientRect();
    const paddingLeft = Number.parseFloat(cardStyle.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(cardStyle.paddingRight) || 0;

    return {
      artWidthGap: Math.round(
        cardBox.width - paddingLeft - paddingRight - artBox.width,
      ),
      coverWidthGap: Math.round(artBox.width - coverBox.width),
    };
  });

  expect(metrics.artWidthGap).toBeLessThanOrEqual(2);
  expect(metrics.coverWidthGap).toBeLessThanOrEqual(1);
}

async function getMobileNavPanelMetrics(page) {
  return page.locator("#app-mobile-nav").evaluate((panel) => {
    const panelBox = panel.getBoundingClientRect();
    return {
      bottomGap: Math.round(window.innerHeight - panelBox.bottom),
      height: Math.round(panelBox.height),
      viewportHeight: window.innerHeight,
    };
  });
}

async function expectAccessUsersShellScrollable(page) {
  const metrics = await page
    .locator(".access-users-table-shell")
    .evaluate((shell) => ({
      overflowY: getComputedStyle(shell).overflowY,
      scrollable: shell.scrollHeight > shell.clientHeight,
    }));

  expect(["auto", "scroll"]).toContain(metrics.overflowY);
  expect(metrics.scrollable).toBe(true);
}

async function expectAccessUsersHeaderLayout(page, { mobile = false } = {}) {
  const metrics = await page
    .getByTestId("access-users-section")
    .evaluate((section) => {
      const toolbar = section.querySelector(".access-users-toolbar");
      const title = toolbar.querySelector("h2").getBoundingClientRect();
      const search = toolbar
        .querySelector(".access-users-search-field")
        .getBoundingClientRect();
      const count = toolbar
        .querySelector(".access-users-result-count")
        .getBoundingClientRect();
      const filter = toolbar
        .querySelector(".access-users-filter-field")
        .getBoundingClientRect();
      const sort = toolbar
        .querySelector(".access-users-sort-field")
        .getBoundingClientRect();
      const filterSelect = toolbar.querySelector(".access-users-filter-field select");
      const sortSelect = toolbar.querySelector(".access-users-sort-field select");

      return {
        countRightGap: Math.round(toolbar.getBoundingClientRect().right - count.right),
        searchAfterTitleGap: Math.round(search.left - title.right),
        searchBeforeCountGap: Math.round(count.left - search.right),
        toolbarLabelCount: toolbar.querySelectorAll(".catalog-toolbar-inline-label").length,
        filterFirstOptionDisabled:
          filterSelect?.options?.[0]?.disabled === true &&
          filterSelect?.options?.[0]?.text === "Filter",
        sortFirstOptionDisabled:
          sortSelect?.options?.[0]?.disabled === true &&
          sortSelect?.options?.[0]?.text === "Sort",
        sameTopLine:
          search.top < title.bottom &&
          count.top < title.bottom &&
          title.top < search.bottom,
        filterSharesTitleRow:
          filter.top < title.bottom && title.top < filter.bottom,
        filterBelowTitle: filter.top >= title.bottom - 1,
        sortSharesFilterRow:
          Math.abs(sort.top - filter.top) <= 1 ||
          (sort.top < filter.bottom && filter.top < sort.bottom),
      };
    });

  expect(metrics.sameTopLine).toBe(true);
  expect(metrics.countRightGap).toBeLessThanOrEqual(1);
  expect(metrics.toolbarLabelCount).toBe(0);
  expect(metrics.filterFirstOptionDisabled).toBe(true);
  expect(metrics.sortFirstOptionDisabled).toBe(true);
  if (mobile) {
    expect(metrics.searchAfterTitleGap).toBeGreaterThanOrEqual(6);
    expect(metrics.searchBeforeCountGap).toBeGreaterThanOrEqual(6);
    expect(metrics.filterBelowTitle).toBe(true);
    expect(metrics.sortSharesFilterRow).toBe(true);
  } else {
    expect(metrics.searchAfterTitleGap).toBeGreaterThanOrEqual(8);
    expect(metrics.searchBeforeCountGap).toBeGreaterThanOrEqual(8);
    expect(metrics.filterSharesTitleRow).toBe(true);
    expect(metrics.sortSharesFilterRow).toBe(true);
  }
}

async function expectMobileProcessingCardShellToPeekNextCard(page, cardTestId) {
  const metrics = await page.getByTestId(cardTestId).evaluate((card) => {
    const shell = card.querySelector(".processing-table-shell");
    const rows = [...card.querySelectorAll(".processing-table tbody tr")];
    const firstRow = rows[0];
    const secondRow = rows[1];
    const shellBox = shell.getBoundingClientRect();
    const firstRowBox = firstRow.getBoundingClientRect();
    const secondRowBox = secondRow.getBoundingClientRect();
    const shellStyle = getComputedStyle(shell);

    return {
      overflowY: shellStyle.overflowY,
      scrollable: shell.scrollHeight > shell.clientHeight,
      firstRowFullyVisible:
        firstRowBox.top >= shellBox.top - 1 &&
        firstRowBox.bottom <= shellBox.bottom + 1,
      secondRowStartsVisible: secondRowBox.top < shellBox.bottom - 8,
      secondRowClipped: secondRowBox.bottom > shellBox.bottom + 8,
    };
  });

  expect(["auto", "scroll"]).toContain(metrics.overflowY);
  expect(metrics.scrollable).toBe(true);
  expect(metrics.firstRowFullyVisible).toBe(true);
  expect(metrics.secondRowStartsVisible).toBe(true);
  expect(metrics.secondRowClipped).toBe(true);
}

async function expectProcessingInlineFilterCountLayout(page, cardTestId) {
  const metrics = await page.getByTestId(cardTestId).evaluate((card) => {
    const title = card.querySelector(".processing-card-head-meta h2").getBoundingClientRect();
    const tools = card.querySelector(".processing-card-head-inline-tools");
    const filter = tools.querySelector(".catalog-filter-toggle").getBoundingClientRect();
    const count = tools
      .querySelector(".processing-card-title-count")
      .getBoundingClientRect();

    return {
      titleLeftOfFilter: title.left < filter.left,
      titleSharesRowWithFilter:
        title.top < filter.bottom && filter.top < title.bottom,
      filterLeftOfCount: filter.left < count.left,
      sameRow: filter.top < count.bottom && count.top < filter.bottom,
    };
  });

  expect(metrics.sameRow).toBe(true);
  expect(metrics.titleLeftOfFilter).toBe(true);
  expect(metrics.titleSharesRowWithFilter).toBe(true);
  expect(metrics.filterLeftOfCount).toBe(true);
}

async function expectTableCardMode(
  page,
  selector,
  { cellDisplay = "grid" } = {},
) {
  const state = await page.locator(selector).evaluate((table) => {
    const thead = table.querySelector("thead");
    const firstRow = table.querySelector("tbody tr");
    const firstCell = table.querySelector("tbody td[data-label]");
    return {
      theadDisplay: thead ? getComputedStyle(thead).display : "",
      rowDisplay: firstRow ? getComputedStyle(firstRow).display : "",
      cellDisplay: firstCell ? getComputedStyle(firstCell).display : "",
      firstLabel: firstCell?.getAttribute("data-label") || "",
    };
  });

  expect(state.theadDisplay).toBe("none");
  expect(state.rowDisplay).toBe("block");
  if (Array.isArray(cellDisplay)) {
    expect(cellDisplay).toContain(state.cellDisplay);
  } else {
    expect(state.cellDisplay).toBe(cellDisplay);
  }
  expect(state.firstLabel).not.toBe("");
}

async function expectMobileTableCellToFillCard(page, selector, cellSelector) {
  const state = await page.locator(selector).evaluate((table, nextCellSelector) => {
    const row = table.querySelector("tbody tr");
    const cell = table.querySelector(nextCellSelector);

    return {
      cellWidth: cell ? Math.round(cell.getBoundingClientRect().width) : 0,
      rowWidth: row ? Math.round(row.getBoundingClientRect().width) : 0,
    };
  }, cellSelector);

  expect(state.rowWidth - state.cellWidth).toBeLessThanOrEqual(2);
}

async function expectDesktopTableMode(page, selector) {
  const state = await page.locator(selector).evaluate((table) => {
    const thead = table.querySelector("thead");
    const firstRow = table.querySelector("tbody tr");
    const firstCell = table.querySelector("tbody td");
    return {
      theadDisplay: thead ? getComputedStyle(thead).display : "",
      rowDisplay: firstRow ? getComputedStyle(firstRow).display : "",
      cellDisplay: firstCell ? getComputedStyle(firstCell).display : "",
    };
  });

  expect(state.theadDisplay).not.toBe("none");
  expect(state.rowDisplay).toBe("table-row");
  expect(state.cellDisplay).toBe("table-cell");
}

async function expectElementsNotOverlapping(page, selectors) {
  const overlaps = await page.evaluate((nextSelectors) => {
    const rects = nextSelectors.map((selector) => {
      const element = document.querySelector(selector);
      if (!element) {
        return { selector, missing: true };
      }
      const rect = element.getBoundingClientRect();
      return {
        selector,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        visible: rect.width > 0 && rect.height > 0,
      };
    });

    const collisions = [];

    for (let index = 0; index < rects.length; index += 1) {
      const left = rects[index];
      if (left.missing || !left.visible) {
        continue;
      }

      for (let otherIndex = index + 1; otherIndex < rects.length; otherIndex += 1) {
        const right = rects[otherIndex];
        if (right.missing || !right.visible) {
          continue;
        }

        const intersects = !(
          left.right <= right.left ||
          right.right <= left.left ||
          left.bottom <= right.top ||
          right.bottom <= left.top
        );

        if (intersects) {
          collisions.push([left.selector, right.selector]);
        }
      }
    }

    return collisions;
  }, selectors);

  expect(overlaps).toEqual([]);
}

test.describe("Responsive layout regression coverage", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: { cookies: [], origins: [] } });

  test("desktop baseline keeps routed large-screen layouts in desktop mode", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockAuthenticatedSession(page, {
      capabilities: ["processing:manage"],
      is_superuser: true,
    });
    await mockCatalogBooksApi(page, 24, {
      savedFilters: [{ id: 1, name: "Recently reviewed books" }],
    });
    await mockAccessApi(page, 24);
    await mockProcessingApi(page);
    await mockProfileApi(page);

    await page.goto("/home");
    await expect(
      page.getByRole("heading", { name: "All Books", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect(page.getByTestId("mobile-nav-trigger")).toBeHidden();
    expect(await getGridColumnCount(page, ".book-grid")).toBe(2);
    await assertNoPageOverflow(page);

    await page.goto("/library");
    await expect(
      page.getByRole("heading", { name: "Books", exact: true }),
    ).toBeVisible();
    await expectDesktopTableMode(page, ".book-table");
    await assertNoPageOverflow(page);

    await page.goto("/access");
    await expect(
      page.getByRole("heading", { name: "Users & Access", exact: true }),
    ).toBeVisible();
    await expectDesktopTableMode(page, ".access-users-table");
    await expectAccessUsersHeaderLayout(page);
    await expectAccessUsersShellScrollable(page);
    expect(await getGridColumnCount(page, ".access-user-editor-primary-row")).toBeGreaterThan(
      1,
    );
    await assertNoPageOverflow(page);

    await page.goto("/catalog");
    await expect(
      page.getByRole("heading", { name: "Catalog", exact: true }),
    ).toBeVisible();
    await expectDesktopTableMode(page, ".processing-table");
    await assertNoPageOverflow(page);

    await page.goto("/profile");
    await page.getByRole("button", { name: "Edit" }).click();
    expect(await getGridColumnCount(page, ".profile-form-grid")).toBe(2);
    await assertNoPageOverflow(page);
  });

  test("tablet landscape keeps desktop nav without topbar overlap", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await mockAuthenticatedSession(page);
    await mockCatalogBooksApi(page);

    await page.goto("/home");

    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect(page.getByTestId("mobile-nav-trigger")).toBeHidden();
    await expectElementsNotOverlapping(page, [
      ".brand-block",
      ".topnav",
      ".session-box",
    ]);
    await assertNoPageOverflow(page);
  });

  test("small tablet header uses the mobile drawer", async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await mockAuthenticatedSession(page);
    await mockCatalogBooksApi(page);

    await page.goto("/home");

    await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
    await expect(page.getByTestId("mobile-nav-trigger")).toBeVisible();
    await page.getByTestId("mobile-nav-trigger").click();
    await expect(page.locator("#app-mobile-nav")).toBeVisible();
    await expect(page.getByRole("link", { name: "My Books" })).toBeVisible();
    await assertNoPageOverflow(page);
  });

  test("tablet portrait uses the mobile drawer while keeping a two-column book grid", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await mockAuthenticatedSession(page);
    await mockCatalogBooksApi(page);

    await page.goto("/home");

    await expect(page.getByTestId("mobile-nav-trigger")).toBeVisible();
    await page.getByTestId("mobile-nav-trigger").click();
    await expect(page.locator("#app-mobile-nav")).toBeVisible();
    await expect(page.getByRole("link", { name: "My Books" })).toBeVisible();
    await page.getByRole("button", { name: "Book Properties" }).click();
    await expect(
      page.getByRole("link", { name: "Books", exact: true }),
    ).toBeVisible();
    expect(await getGridColumnCount(page, ".book-grid")).toBe(2);
    await assertNoPageOverflow(page);
  });

  test("phone home view uses the mobile drawer and a single-column card grid", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockAuthenticatedSession(page);
    await mockCatalogBooksApi(page);

    await page.goto("/home");

    await expect(page.getByTestId("mobile-nav-trigger")).toBeVisible();
    await page.getByTestId("mobile-nav-trigger").click();
    await expect(page.locator("#app-mobile-nav")).toBeVisible();
    await expect(page.getByRole("button", { name: "Processing" })).toBeVisible();
    expect(await getGridColumnCount(page, ".book-grid")).toBe(1);
    await expectFirstBookCoverToFillCardWidth(page);

    await page.goto("/created-books");

    await expect(
      page.getByRole("heading", { name: "My Books", exact: true }),
    ).toBeVisible();
    expect(await getGridColumnCount(page, ".book-grid")).toBe(1);
    await expectFirstBookCoverToFillCardWidth(page);
    await assertNoPageOverflow(page);
  });

  test("phone mobile drawer collapses to content when processing links are unavailable", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockAuthenticatedSession(page, {
      is_staff: false,
      is_superuser: false,
      capabilities: [],
    });
    await mockCatalogBooksApi(page);

    await page.goto("/home");

    await page.getByTestId("mobile-nav-trigger").click();
    await expect(page.locator("#app-mobile-nav")).toBeVisible();
    await expect(page.getByRole("button", { name: "Processing" })).toHaveCount(0);
    const panelMetrics = await getMobileNavPanelMetrics(page);
    expect(panelMetrics.height).toBeLessThan(panelMetrics.viewportHeight - 120);
    expect(panelMetrics.bottomGap).toBeGreaterThanOrEqual(40);
    await assertNoPageOverflow(page);
  });

  test("phone library organizes the toolbar and cardifies the table", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockAuthenticatedSession(page);
    await mockCatalogBooksApi(page, 24, {
      savedFilters: [
        { id: 1, name: "Architecture books" },
        { id: 2, name: "Needs review and manual follow-up" },
      ],
    });

    await page.goto("/library");

    await expect(
      page.getByRole("heading", { name: "Books", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "CSV export" })).toBeVisible();
    await expect(
      page
        .locator(".saved-filter-apply")
        .filter({ hasText: "Needs review and manual follow-up" }),
    ).toBeVisible();
    const toolbarLayout = await page
      .locator(".catalog-page-header--property-layout")
      .evaluate((header) => {
        const headerBox = header.getBoundingClientRect();
        const searchBox = header
          .querySelector(".catalog-search-field")
          .getBoundingClientRect();
        const filterButton = header.querySelector(".catalog-filter-toggle");
        const filterBox = filterButton.getBoundingClientRect();
        const sortBox = header
          .querySelector(".catalog-search-sort")
          .getBoundingClientRect();
        const countBox = header
          .querySelector(".catalog-result-count")
          .getBoundingClientRect();
        const extraBox = header
          .querySelector(".catalog-search-actions-extra")
          .getBoundingClientRect();
        const exportButtons = [
          ...header.querySelectorAll(".export-action-button"),
        ].map((button) => button.getBoundingClientRect());
        return {
          countRightGap: Math.round(headerBox.right - countBox.right),
          countTopGap: Math.round(countBox.top - headerBox.top),
          exportButtonTopGap: exportButtons.length === 2
            ? Math.abs(Math.round(exportButtons[0].top - exportButtons[1].top))
            : null,
          exportButtonsCombinedWidth: exportButtons.length === 2
            ? Math.round(
                exportButtons[0].width +
                  exportButtons[1].width +
                  (exportButtons[1].left - exportButtons[0].right),
              )
            : 0,
          extraWidth: Math.round(extraBox.width),
          filterGap: getComputedStyle(filterButton).columnGap,
          filterWidth: Math.round(filterBox.width),
          filterSortCombinedWidth: Math.round(
            filterBox.width + sortBox.width + (sortBox.left - filterBox.right),
          ),
          filterSortTopGap: Math.abs(Math.round(filterBox.top - sortBox.top)),
          headerWidth: Math.round(headerBox.width),
          searchLeftGap: Math.round(searchBox.left - headerBox.left),
          searchRightGap: Math.round(headerBox.right - searchBox.right),
          sortWidth: Math.round(sortBox.width),
        };
      });
    expect(toolbarLayout.countRightGap).toBeLessThanOrEqual(1);
    expect(toolbarLayout.countTopGap).toBeLessThanOrEqual(1);
    expect(toolbarLayout.exportButtonTopGap).toBeLessThanOrEqual(1);
    expect(toolbarLayout.exportButtonsCombinedWidth).toBe(toolbarLayout.extraWidth);
    expect(toolbarLayout.filterGap).toBe("6px");
    expect(toolbarLayout.filterSortCombinedWidth).toBe(toolbarLayout.headerWidth);
    expect(toolbarLayout.filterSortTopGap).toBeLessThanOrEqual(1);
    expect(toolbarLayout.filterWidth).toBeLessThan(toolbarLayout.sortWidth);
    expect(toolbarLayout.searchLeftGap).toBeLessThanOrEqual(1);
    expect(toolbarLayout.searchRightGap).toBeLessThanOrEqual(1);
    await expectTableCardMode(page, ".book-table");
    await assertNoPageOverflow(page);
  });

  test("phone book property pages render mobile table items like the books page", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockAuthenticatedSession(page);
    await mockPropertyPagesApi(page);

    await page.goto("/categories");
    await expect(
      page.getByRole("heading", { name: "Categories", exact: true }),
    ).toBeVisible();
    await expectTableCardMode(page, ".property-table");
    await expectMobileTableCellToFillCard(
      page,
      ".property-table",
      'tbody td[data-label="Name"]',
    );
    await assertNoPageOverflow(page);

    await page.goto("/series");
    await expect(
      page.getByRole("heading", { name: "Series", exact: true }),
    ).toBeVisible();
    await expectTableCardMode(page, ".property-table");
    await expectMobileTableCellToFillCard(
      page,
      ".property-table",
      'tbody td[data-label="Series"]',
    );
    await assertNoPageOverflow(page);

    await page.goto("/writers");
    await expect(
      page.getByRole("heading", { name: "Writers", exact: true }),
    ).toBeVisible();
    await expectTableCardMode(page, ".property-table");
    await expectMobileTableCellToFillCard(
      page,
      ".property-table",
      'tbody td[data-label="Name"]',
    );
    await assertNoPageOverflow(page);
  });

  test("phone access page stacks form fields and cardifies the users table", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockAuthenticatedSession(page);
    await mockAccessApi(page, 24);

    await page.goto("/access");

    await expect(
      page.getByRole("heading", { name: "Users & Access", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("access-user-form")).toBeVisible();
    expect(await getGridColumnCount(page, ".access-user-editor-primary-row")).toBe(1);
    await expectAccessUsersHeaderLayout(page, { mobile: true });
    await expectAccessUsersShellScrollable(page);
    await expectTableCardMode(page, ".access-users-table");
    await assertNoPageOverflow(page);
  });

  test("phone processing catalog page reflows summary cards and renders dense rows as mobile cards", async ({
    page,
  }) => {
    async function getAutomationHeaderLayout(testId) {
      return page.getByTestId(testId).evaluate((card) => {
        const header = card.querySelector(".processing-card-head--settings");
        const title = header
          .querySelector(".processing-card-head-meta h2")
          .getBoundingClientRect();
        const controls = header
          .querySelector(".processing-card-head-controls")
          .getBoundingClientRect();

        return {
          sameRow:
            controls.top < title.bottom && controls.bottom > title.top,
        };
      });
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await mockAuthenticatedSession(page);
    await mockCatalogBooksApi(page, 0);
    await mockProcessingApi(page);

    await page.goto("/catalog");

    await expect(
      page.getByRole("heading", { name: "Catalog", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("catalog-records-table")).toBeVisible();
    expect(await getGridColumnCount(page, ".processing-card-grid")).toBe(1);
    const processingCardLayout = await page
      .getByTestId("catalog-records-card")
      .evaluate((card) => {
        const titleRow = card
          .querySelector(".processing-card-title-row")
          .getBoundingClientRect();
        const countBox = card
          .querySelector('[data-testid="catalog-records-count"]')
          .getBoundingClientRect();
        const filterButton = card.querySelector(".catalog-filter-toggle");
        const filterBox = filterButton.getBoundingClientRect();
        const actionsBox = card
          .querySelector(".processing-card-head-actions")
          .getBoundingClientRect();
        const actionButtonBox = card
          .querySelector('[data-testid="catalog-records-create-btn"]')
          .getBoundingClientRect();

        return {
          actionFillsActions: Math.round(
            actionsBox.width - actionButtonBox.width,
          ),
          actionRightGap: Math.round(actionsBox.right - actionButtonBox.right),
          actionStartsBelowFilter: actionButtonBox.top >= filterBox.bottom - 1,
          countRightGap: Math.round(titleRow.right - countBox.right),
          countCenterDelta: Math.round(
            Math.abs(
              countBox.top +
                countBox.height / 2 -
                (titleRow.top + titleRow.height / 2),
            ),
          ),
          filterGap: getComputedStyle(filterButton).columnGap,
          filterWidth: Math.round(filterBox.width),
          actionWidth: Math.round(actionButtonBox.width),
        };
      });
    expect(processingCardLayout.countRightGap).toBeLessThanOrEqual(1);
    expect(processingCardLayout.countCenterDelta).toBeLessThanOrEqual(1);
    expect(processingCardLayout.filterGap).toBe("6px");
    expect(processingCardLayout.filterWidth).toBeLessThan(
      processingCardLayout.actionWidth,
    );
    expect(processingCardLayout.actionStartsBelowFilter).toBe(true);
    expect(processingCardLayout.actionFillsActions).toBeLessThanOrEqual(1);
    expect(processingCardLayout.actionRightGap).toBeLessThanOrEqual(1);
    const automationHeaderLayout = await getAutomationHeaderLayout(
      "catalog-automation-card",
    );
    expect(automationHeaderLayout.sameRow).toBe(true);
    await expectTableCardMode(page, ".processing-table", {
      cellDisplay: ["grid", "inline-flex"],
    });
    const processingCellLayout = await page
      .getByTestId("catalog-records-table")
      .evaluate((table) => {
        const row = table.querySelector("tbody tr");
        const nameCell = table.querySelector("tbody td.processing-col-name");
        const selectCell = table.querySelector("tbody td.processing-col-select");
        const nameCellStyle = getComputedStyle(nameCell);
        const selectCellStyle = getComputedStyle(selectCell);
        const rowBox = row.getBoundingClientRect();
        const nameCellBox = nameCell.getBoundingClientRect();

        return {
          cellDisplay: nameCellStyle.display,
          gridTemplateColumns: nameCellStyle.gridTemplateColumns,
          rowCellWidthDelta: Math.round(rowBox.width - nameCellBox.width),
          selectCellDisplay: selectCellStyle.display,
        };
      });
    expect(processingCellLayout.cellDisplay).toBe("grid");
    expect(processingCellLayout.gridTemplateColumns).not.toBe("none");
    expect(processingCellLayout.rowCellWidthDelta).toBeLessThanOrEqual(2);
    expect(processingCellLayout.selectCellDisplay).toBe("inline-flex");
    await expectMobileProcessingCardShellToPeekNextCard(
      page,
      "catalog-records-card",
    );
    await assertNoPageOverflow(page);

    await page.goto("/processing-incomplete-check");
    await expect(
      page.getByRole("heading", {
        name: "Incomplete",
        exact: true,
        level: 1,
      }),
    ).toBeVisible();
    await expectProcessingInlineFilterCountLayout(
      page,
      "incomplete-records-card",
    );
    await expectProcessingInlineFilterCountLayout(
      page,
      "incomplete-completed-card",
    );
    const incompleteAutomationHeaderLayout = await getAutomationHeaderLayout(
      "incomplete-automation-card",
    );
    expect(incompleteAutomationHeaderLayout.sameRow).toBe(true);
    await assertNoPageOverflow(page);
  });

  test("phone manual books page stacks toolbar actions and composer fields", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockAuthenticatedSession(page);
    await mockManualBooksApi(page);

    await page.goto("/manual-books");

    await expect(
      page.getByRole("heading", { name: "Physical Books' List", exact: true }),
    ).toBeVisible();
    const manualToolbarLayout = await page
      .locator(".catalog-page-header--property-layout")
      .evaluate((header) => {
        const extraBox = header
          .querySelector(".catalog-search-actions-extra")
          .getBoundingClientRect();
        const addButtonBox = header
          .querySelector('[aria-label="Add manual book"]')
          .getBoundingClientRect();
        const exportButtons = [
          ...header.querySelectorAll(".export-action-button"),
        ].map((button) => button.getBoundingClientRect());
        return {
          addButtonRightGap: Math.round(extraBox.right - addButtonBox.right),
          addButtonWidth: Math.round(addButtonBox.width),
          exportButtonTopGap: exportButtons.length === 2
            ? Math.abs(Math.round(exportButtons[0].top - exportButtons[1].top))
            : null,
          exportButtonsCombinedWidth: exportButtons.length === 2
            ? Math.round(
                exportButtons[0].width +
                  exportButtons[1].width +
                  (exportButtons[1].left - exportButtons[0].right),
              )
            : 0,
          extraWidth: Math.round(extraBox.width),
        };
      });
    expect(manualToolbarLayout.addButtonRightGap).toBeLessThanOrEqual(1);
    expect(manualToolbarLayout.addButtonWidth).toBeLessThanOrEqual(48);
    expect(manualToolbarLayout.exportButtonTopGap).toBeLessThanOrEqual(1);
    expect(manualToolbarLayout.exportButtonsCombinedWidth).toBe(
      manualToolbarLayout.extraWidth,
    );
    await page.getByRole("button", { name: "Add manual book" }).click();
    await expect(page.locator("#manual-book-composer")).toBeVisible();
    const manualFormColumns = await page
      .locator(".manual-book-form-grid")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const columns = getComputedStyle(node).gridTemplateColumns.trim();
          if (!columns || columns === "none") {
            return 0;
          }
          return columns.split(/\s+/).length;
        }),
      );
    expect(manualFormColumns.length).toBeGreaterThan(0);
    expect(manualFormColumns.every((columnCount) => columnCount === 1)).toBe(
      true,
    );
    await assertNoPageOverflow(page);
  });

  test("narrow phone profile editor keeps stacked sections readable at 320px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await mockAuthenticatedSession(page, {
      is_superuser: false,
      is_staff: false,
      capabilities: [],
    });
    await mockProfileApi(page);

    await page.goto("/profile");

    await expect(
      page.getByRole("heading", { name: "Profile", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Edit" }).click();
    await expect(
      page.getByRole("heading", { name: "Change Password" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Expand" }).first().click();
    expect(await getGridColumnCount(page, ".profile-form-grid")).toBe(1);
    expect(await getGridColumnCount(page, ".profile-password-grid")).toBe(1);
    await page.getByRole("button", { name: "Save Changes" }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Save Changes" })).toBeVisible();
    await assertNoPageOverflow(page);
  });
});

test.describe("Responsive live reader coverage", () => {
  test("book detail and reader stay contained at landscape tablet size", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await loginAsSuperAdmin(page);

    await page.goto(`/books/${seedData.books.detail.slug}`);
    await expect(page.getByTestId("book-detail-hero")).toBeVisible();
    await assertNoPageOverflow(page);

    await page.getByTestId("book-open-reader-button").click();
    await expect(page).toHaveURL(/\/reader\?/);
    await expect(page.locator("#reader-view")).toBeVisible();
    await expect(page.locator("#viewer iframe")).toBeVisible({
      timeout: 15_000,
    });
    await assertNoPageOverflow(page);
  });
});
