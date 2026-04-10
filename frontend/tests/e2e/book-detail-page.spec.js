import { expect, test } from "playwright/test";
import { BookDetailPageModel } from "./pages/bookDetailPage";
import {
  installApiGuard,
  installWindowOpenRecorder,
  mockAuthenticatedSession,
  readOpenedUrls,
} from "./support/appMocks";
import { mockBookDetailApi } from "./support/bookDetailApi";

test.describe("Book Detail Page", () => {
  test("removing a bookmark does not clear metadata edits in progress", async ({ page }) => {
    await installApiGuard(page);
    await mockAuthenticatedSession(page);
    const state = await mockBookDetailApi(page);
    const bookPage = new BookDetailPageModel(page);

    await bookPage.goto();
    await bookPage.fillMetadataTitle("Edited While Bookmark Changes");
    await bookPage.removeBookmark("bookmark-1");

    await expect.poll(() => state.bookmarkDeleteCalls.length).toBe(1);
    await expect(bookPage.titleInput()).toHaveValue(
      "Edited While Bookmark Changes",
    );
    await expect(page.getByText("Opening")).toHaveCount(0);
  });

  test("preview locks only disable html preview while other book actions keep working", async ({ page }) => {
    await installApiGuard(page);
    await mockAuthenticatedSession(page);
    const state = await mockBookDetailApi(page);
    await installWindowOpenRecorder(page);
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "ebook_preview_lock:/api/assets/mock-book/book.html",
        JSON.stringify({ tabId: "tab-1", ts: Date.now() }),
      );
    });
    const bookPage = new BookDetailPageModel(page);

    await bookPage.goto();
    await expect(bookPage.htmlPreviewButton()).toBeDisabled();
    await expect(bookPage.epubButton()).toBeEnabled();

    await bookPage.epubButton().click();
    await expect
      .poll(async () => readOpenedUrls(page))
      .toContain("http://127.0.0.1:5173/api/assets/mock-book/book.epub");

    await bookPage.fillMetadataTitle("Preview Lock Safe Title");
    await bookPage.saveMetadata();
    await expect.poll(() => state.metadataUpdateCalls.length).toBe(1);
    await expect(state.metadataUpdateCalls[0].title).toBe(
      "Preview Lock Safe Title",
    );
  });
});
