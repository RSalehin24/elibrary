import { routeJson } from "./appMocks";

function parseJsonBody(route) {
  const body = route.request().postData() || "{}";
  return JSON.parse(body);
}

export async function mockBookDetailApi(page, slug = "mock-book") {
  const book = {
    id: "book-1",
    slug,
    title: "Mock Book",
    summary: "Original summary",
    state: "ready",
    review_state: "pending",
    record_type: "source",
    catalog_code: "BOOK-101",
    contributors: [{ name: "Author One", role: "author" }],
    series: ["Series A"],
    categories: ["Poetry"],
    source_records: [
      {
        url: "https://www.example.com/books/mock-book/",
        display_url: "https://www.example.com/books/mock-book/",
        display_path: "books/mock-book/",
        source_title: "Mock Source",
        site: "Example",
        is_primary: true,
      },
    ],
    front_matter: [
      { key: "language", label: "Language", value: "Bangla" },
      { key: "catalog_code", label: "Catalog Code", value: "OUTDATED" },
    ],
    book_info_html: "<p>Fallback details</p>",
    dedication_html: "<p>For readers.</p>",
    toc: [{ title: "Chapter 1", children: [{ title: "Section 1" }] }],
    content_items: [],
    latest_processing_job: null,
    raw_provenance: {},
    assets: [
      {
        id: "asset-html",
        asset_type: "html",
        download_url: "/api/assets/mock-book/book.html",
      },
      {
        id: "asset-epub",
        asset_type: "epub",
        download_url: "/api/assets/mock-book/book.epub",
      },
    ],
  };

  const state = {
    bookmarkDeleteCalls: [],
    bookmarks: [
      {
        id: "bookmark-1",
        label: "Opening",
        location: "Chapter 1",
        note: "Keep this",
      },
      {
        id: "bookmark-2",
        label: "Closing",
        location: "Chapter 10",
        note: "",
      },
    ],
    book,
    metadataReviewCreateCalls: [],
    metadataReviewUpdateCalls: [],
    metadataReviews: [
      {
        id: "review-1",
        state: "pending",
        notes: "Check contributor spelling.",
        requested_by_email: "editor@example.com",
        updated_at: "2026-04-10T08:00:00Z",
      },
    ],
    metadataUpdateCalls: [],
    metadataVersions: [
      {
        id: "version-1",
        source: "scrape",
        notes: "Imported from source.",
        created_at: "2026-04-09T12:00:00Z",
      },
    ],
    readingSession: {
      last_location: "Chapter 1",
      progress_percent: 34,
      last_opened_at: "2026-04-10T09:30:00Z",
    },
  };

  await page.route(`**/api/catalog/books/${slug}/`, async (route) => {
    await routeJson(route, state.book);
  });

  await page.route(`**/api/access/books/${slug}/reading-session/`, async (route) => {
    await routeJson(route, state.readingSession);
  });

  await page.route(`**/api/access/books/${slug}/bookmarks/`, async (route) => {
    await routeJson(route, state.bookmarks);
  });

  await page.route(/.*\/api\/access\/bookmarks\/[^/]+\/$/, async (route) => {
    const bookmarkId = route.request().url().split("/").filter(Boolean).at(-1);
    state.bookmarkDeleteCalls.push(bookmarkId);
    state.bookmarks = state.bookmarks.filter((entry) => entry.id !== bookmarkId);
    await route.fulfill({ status: 204 });
  });

  await page.route(`**/api/catalog/books/${slug}/metadata-versions/`, async (route) => {
    await routeJson(route, state.metadataVersions);
  });

  await page.route(`**/api/catalog/books/${slug}/metadata-reviews/`, async (route) => {
    if (route.request().method() === "GET") {
      await routeJson(route, state.metadataReviews);
      return;
    }

    const payload = parseJsonBody(route);
    state.metadataReviewCreateCalls.push(payload);
    const createdReview = {
      id: `review-${state.metadataReviews.length + 1}`,
      state: payload.state,
      notes: payload.notes,
      requested_by_email: "admin@example.com",
      updated_at: "2026-04-10T10:15:00Z",
    };
    state.book.review_state = payload.state;
    state.metadataReviews = [createdReview, ...state.metadataReviews];
    await routeJson(route, createdReview, 201);
  });

  await page.route(`**/api/catalog/books/${slug}/metadata/`, async (route) => {
    const payload = parseJsonBody(route);
    state.metadataUpdateCalls.push(payload);
    state.book = {
      ...state.book,
      title: payload.title,
      summary: payload.summary,
      series: payload.series,
      categories: payload.categories,
      contributors: payload.contributors,
    };
    await routeJson(route, state.book);
  });

  await page.route(/.*\/api\/catalog\/metadata-reviews\/[^/]+\/$/, async (route) => {
    const reviewId = route.request().url().split("/").filter(Boolean).at(-1);
    const payload = parseJsonBody(route);
    state.metadataReviewUpdateCalls.push({ reviewId, payload });
    state.metadataReviews = state.metadataReviews.map((entry) =>
      entry.id === reviewId ? { ...entry, ...payload } : entry,
    );
    state.book.review_state = payload.state || state.book.review_state;
    await routeJson(
      route,
      state.metadataReviews.find((entry) => entry.id === reviewId),
    );
  });

  return state;
}
