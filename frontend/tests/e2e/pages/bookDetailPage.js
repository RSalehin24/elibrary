import { expect } from "playwright/test";

export class BookDetailPageModel {
  constructor(page) {
    this.page = page;
    this.hero = page.getByTestId("book-detail-hero");
    this.metadataWorkspace = page.getByTestId("book-metadata-workspace");
  }

  async goto(slug = "mock-book") {
    await this.page.goto(`/books/${slug}`);
    await expect(this.hero).toBeVisible();
  }

  titleInput() {
    return this.metadataWorkspace.getByLabel("Title");
  }

  async fillMetadataTitle(value) {
    await this.titleInput().fill(value);
  }

  async saveMetadata() {
    await this.metadataWorkspace
      .getByRole("button", { name: "Save metadata" })
      .click();
  }

  async saveReview() {
    await this.metadataWorkspace
      .getByRole("button", { name: "Save review" })
      .click();
  }

  async setReviewState(value) {
    await this.metadataWorkspace.getByLabel("Review state").selectOption(value);
  }

  async setReviewNotes(value) {
    await this.metadataWorkspace.getByLabel("Notes").fill(value);
  }

  async approveReview() {
    await this.metadataWorkspace
      .getByRole("button", { name: "Approve" })
      .first()
      .click();
  }

  async removeBookmark(bookmarkId) {
    await this.page.getByTestId(`bookmark-remove-${bookmarkId}`).click();
  }

  htmlPreviewButton() {
    return this.page.getByTestId("book-asset-html");
  }

  epubButton() {
    return this.page.getByTestId("book-asset-epub");
  }
}
