import { expect, test } from "playwright/test";
import { AccessPageModel } from "./pages/accessPage";
import {
  installApiGuard,
  mockAuthenticatedSession,
} from "./support/appMocks";
import { mockAccessApi } from "./support/accessApi";

test.describe("Access Page", () => {
  test("editing a user keeps the active list filters intact", async ({ page }) => {
    await installApiGuard(page);
    await mockAuthenticatedSession(page);
    const state = await mockAccessApi(page);
    const accessPage = new AccessPageModel(page);

    await accessPage.goto();
    await accessPage.searchUsers("writer");
    await accessPage.filterUsersByStatus("active");
    await accessPage.editUserByEmail("writer@example.com");
    await accessPage.setRequireTwoFactor(true);
    await accessPage.saveUser();

    await expect(accessPage.userSearchInput).toHaveValue("writer");
    await expect(accessPage.userStatusFilter).toHaveValue("active");
    await expect(
      accessPage.usersTable.getByText("writer@example.com"),
    ).toBeVisible();
    await expect.poll(() => state.userUpdateCalls.length).toBe(1);
    await expect(state.userUpdateCalls[0]).toEqual({
      userId: "user-2",
      payload: {
        global_scopes: ["metadata:edit"],
        is_active: true,
        totp_required: true,
      },
    });
  });

  test("creating access rules skips duplicate scoped combinations", async ({ page }) => {
    await installApiGuard(page);
    await mockAuthenticatedSession(page);
    const state = await mockAccessApi(page);
    const accessPage = new AccessPageModel(page);

    await accessPage.goto();
    await accessPage.switchToAccessRules();
    await accessPage.selectGrantUser("user-2");
    await accessPage.toggleGrantPermission("Metadata Edit");
    await accessPage.chooseGrantTargetType("Books");
    await accessPage.searchTargets("Book");
    await accessPage.toggleTarget("Book One");
    await accessPage.toggleTarget("Book Two");
    await accessPage.saveAccessRule();

    await expect.poll(() => state.grantCreateCalls.length).toBe(1);
    await expect(state.grantCreateCalls[0]).toEqual({
      book: "book-2",
      expires_at: null,
      notes: "",
      scope: "metadata:edit",
      user: "user-2",
    });
    await expect(accessPage.accessRulesTable.getByText("Book Two")).toBeVisible();
  });
});
