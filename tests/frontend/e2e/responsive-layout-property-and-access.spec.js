import { expect, test } from "./support/playwright";
import { assertNoPageOverflow, expectAccessUsersHeaderLayout, expectAccessUsersShellScrollable, expectMobileTableCellToFillCard, expectTableCardMode, getGridColumnCount, mockAccessApi, mockAuthenticatedSession, mockPropertyPagesApi } from "./responsive-layout/index.js";

test.describe("responsive layout property and access coverage", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: { cookies: [], origins: [] } });

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
});
