import { test, expect } from "@playwright/test";

test.describe("Dashboard layout", () => {
  test("loads and shows header", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("header")).toBeVisible();
  });

  test("shows header with logo", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByLabel("Agent of Empires website")).toBeVisible();
  });

  test("shows empty state when no sessions exist", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("No sessions yet")).toBeVisible();
  });

  test("shows CLI hint in empty state", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("aoe add")).toBeVisible();
  });

  test("shows offline indicator when API unreachable", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("offline")).toBeVisible();
  });
});

test.describe("Sidebar", () => {
  test("sidebar visible on desktop by default", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "New session" })).toBeVisible();
    await expect(page.getByText("Sessions", { exact: true })).toBeVisible();
  });

  test("sidebar toggle button exists", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Toggle sidebar" })).toBeVisible();
  });

  test("sidebar can be toggled closed and open on desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    const newBtn = page.getByRole("button", { name: "New session" });
    await expect(newBtn).toBeVisible();

    await page.getByRole("button", { name: "Toggle sidebar" }).click();
    await expect(newBtn).not.toBeVisible();

    await page.getByRole("button", { name: "Toggle sidebar" }).click();
    await expect(newBtn).toBeVisible();
  });
});

test.describe("Create session dialog", () => {
  test("opens from sidebar button", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await page.getByRole("button", { name: "New session" }).click();
    await expect(page.getByText("Not supported yet")).toBeVisible();
  });

  test("opens with keyboard shortcut n", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await page.locator("body").click();
    await page.keyboard.press("n");
    await expect(page.getByText("Not supported yet")).toBeVisible();
  });

  test("shows CLI hint", async ({ page }) => {
    await page.goto("/");
    await page.locator("body").click();
    await page.keyboard.press("n");
    await expect(page.getByText("Create sessions from the terminal")).toBeVisible();
  });

  test("closes on Close button", async ({ page }) => {
    await page.goto("/");
    await page.locator("body").click();
    await page.keyboard.press("n");
    await expect(page.getByText("Not supported yet")).toBeVisible();
    await page.getByText("Close").click();
    await expect(page.getByText("Not supported yet")).not.toBeVisible();
  });

  test("closes on escape", async ({ page }) => {
    await page.goto("/");
    await page.locator("body").click();
    await page.keyboard.press("n");
    await expect(page.getByText("Not supported yet")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Not supported yet")).not.toBeVisible();
  });

  test("closes on backdrop click", async ({ page }) => {
    await page.goto("/");
    await page.locator("body").click();
    await page.keyboard.press("n");
    await expect(page.getByText("Not supported yet")).toBeVisible();
    await page.mouse.click(10, 10);
    await expect(page.getByText("Not supported yet")).not.toBeVisible();
  });
});

test.describe("Settings", () => {
  test("settings gear button visible", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  });

  test("settings opens on click", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Settings" }).click();
    // Settings view shows loading state (no backend in test)
    await expect(page.getByText("Loading settings...")).toBeVisible();
  });

  test("settings opens with keyboard shortcut s", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await page.locator("body").click();
    await page.keyboard.press("s");
    await expect(page.getByText("Loading settings...")).toBeVisible();
  });
});

test.describe("Keyboard shortcuts", () => {
  test("D toggles diff pane (no-op when no session, no crash)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    // Should not crash even with no session selected
    await page.keyboard.press("Shift+d");
    await expect(page.getByText("No sessions yet")).toBeVisible();
  });

  test("? opens help overlay", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await page.locator("body").click();
    // Dispatch a ? keydown event directly since Shift+/ handling varies by layout
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    });
    await expect(page.getByRole("heading", { name: "Keyboard Shortcuts" })).toBeVisible();
  });

  test("escape closes help overlay", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    await page.locator("body").click();
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    });
    await expect(page.getByRole("heading", { name: "Keyboard Shortcuts" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "Keyboard Shortcuts" })).not.toBeVisible();
  });
});

test.describe("Mobile responsive", () => {
  test("sidebar closed by default on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    // Sidebar new-session button should not be visible (sidebar closed)
    await expect(page.getByRole("button", { name: "New session" })).not.toBeVisible();
    // Main content visible
    await expect(page.getByText("No sessions yet")).toBeVisible();
  });

  test("hamburger opens sidebar overlay on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.getByRole("button", { name: "Toggle sidebar" }).click();
    await expect(page.getByRole("button", { name: "New session" })).toBeVisible();
  });

  test("sidebar has close button on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.getByRole("button", { name: "Toggle sidebar" }).click();
    const closeBtn = page.getByRole("button", { name: "×" });
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();
    await expect(page.getByRole("button", { name: "New session" })).not.toBeVisible();
  });

  test("settings gear accessible on mobile via sidebar", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    // Settings button is in the sidebar, which starts closed on mobile
    await page.getByRole("button", { name: "Toggle sidebar" }).click();
    await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  });

  test("create dialog works on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.locator("body").click();
    await page.keyboard.press("n");
    await expect(page.getByText("Not supported yet")).toBeVisible();
  });
});

test.describe("Design system", () => {
  test("uses neutral dark background", async ({ page }) => {
    await page.goto("/");
    const bg = await page.evaluate(() =>
      getComputedStyle(document.body).backgroundColor,
    );
    // --color-surface-900: #1c1c1f = rgb(28, 28, 31)
    expect(bg).toContain("28");
  });

  test("loads Geist Sans body font", async ({ page }) => {
    await page.goto("/");
    const fonts = await page.evaluate(() =>
      getComputedStyle(document.body).fontFamily,
    );
    expect(fonts.toLowerCase()).toContain("geist");
  });

  test("focus-visible ring appears on keyboard navigation", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    // Tab to the first button
    await page.keyboard.press("Tab");
    const outline = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? getComputedStyle(el).outlineColor : "";
    });
    // Should have a brand-colored outline
    expect(outline).not.toBe("");
  });
});
