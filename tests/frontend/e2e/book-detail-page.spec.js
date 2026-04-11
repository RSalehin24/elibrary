import { expect, test } from "./support/playwright";
import { BookDetailPageModel } from "./pages/bookDetailPage";
import {
  installWindowOpenRecorder,
  loginAsSuperAdmin,
  readOpenedUrls,
} from "./support/liveApp";
import { seedData } from "./support/seedData";

test.describe("Book Detail Page", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsSuperAdmin(page);
  });

  test("removing a bookmark does not clear metadata edits in progress", async ({
    page,
  }) => {
    const bookPage = new BookDetailPageModel(page);
    const updatedTitle = "E2E Detail Book Updated";

    await bookPage.goto(seedData.books.detail.slug);
    try {
      await bookPage.fillMetadataTitle(updatedTitle);
      await bookPage.removeBookmark(seedData.bookmark.label);
      await bookPage.saveMetadata();

      await expect(page).toHaveURL(/\/books\/e2e-detail-book-updated$/);
      await page.reload();
      await expect(bookPage.titleInput()).toHaveValue(updatedTitle);
      await expect(page.getByText(seedData.bookmark.label)).toHaveCount(0);
      await expect(page.getByText("Opening")).toHaveCount(0);
    } finally {
      await bookPage.fillMetadataTitle(seedData.books.detail.title);
      await bookPage.saveMetadata();
      await expect(page).toHaveURL(new RegExp(`/books/${seedData.books.detail.slug}$`));
    }
  });

  test("preview locks only disable html preview while other book actions keep working", async ({
    page,
  }) => {
    await installWindowOpenRecorder(page);
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "ebook_preview_lock:/api/access/books/e2e-preview-book/download/html/",
        JSON.stringify({ tabId: "tab-1", ts: Date.now() }),
      );
    });
    const bookPage = new BookDetailPageModel(page);

    await bookPage.goto(seedData.books.preview.slug);
    await expect(bookPage.htmlPreviewButton()).toBeDisabled();
    await expect(bookPage.epubButton()).toBeEnabled();

    const expectedEpubUrl = new URL(
      `/api/access/books/${seedData.books.preview.slug}/download/epub/`,
      page.url(),
    ).toString();

    await bookPage.epubButton().click();
    await expect
      .poll(async () => readOpenedUrls(page))
      .toContain(expectedEpubUrl);
  });
});
