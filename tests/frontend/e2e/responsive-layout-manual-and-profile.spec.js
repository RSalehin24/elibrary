import { expect, test } from "./support/playwright";
import { assertNoPageOverflow, getGridColumnCount, mockAuthenticatedSession, mockManualBooksApi, mockProfileApi } from "./responsive-layout/index.js";

test.describe("responsive layout manual books and profile coverage", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: { cookies: [], origins: [] } });

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
