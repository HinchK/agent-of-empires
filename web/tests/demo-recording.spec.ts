import { test } from "@playwright/test";

/**
 * Narrative demo recording for the web dashboard.
 *
 * Requires: aoe serve running on localhost:8080 with pre-seeded sessions.
 * Run via: ./scripts/demo-web.sh (handles setup, recording, and conversion)
 *
 * Storyboard:
 *   Beat 1 - Dashboard loads with 3 sessions in sidebar
 *   Beat 2 - Select second workspace
 *   Beat 3 - Toggle diff panel (Shift+D)
 *   Beat 4 - Close diff, select third workspace
 *   Beat 5 - Open help overlay (?)
 *   Beat 6 - Close help
 */
test("web dashboard demo recording", async ({ page }) => {
  // Beat 1: Dashboard loads with pre-seeded sessions
  await page.goto("/");

  // Wait for sidebar to show session list
  await page.waitForSelector("text=Sessions", { timeout: 15_000 });

  // Wait for first session to appear (server polls every 2s)
  await page.waitForSelector('button:has-text("API Server")', {
    timeout: 15_000,
  });

  // Click first session to select it and show terminal
  await page.locator("button").filter({ hasText: "API Server" }).first().click();
  await page.waitForTimeout(2_000);

  // Screenshot: populated dashboard with terminal view
  await page.screenshot({
    path: "../docs/assets/web-dashboard.png",
    fullPage: false,
  });

  // Beat 2: Select second workspace
  await page.locator("button").filter({ hasText: "Web App" }).first().click();
  await page.waitForTimeout(2_000);

  // Beat 3: Toggle diff panel
  await page.keyboard.press("Shift+d");
  await page.waitForTimeout(2_000);

  // Screenshot: diff panel open alongside terminal
  await page.screenshot({
    path: "../docs/assets/web-diff.png",
    fullPage: false,
  });

  // Beat 4: Close diff, select third workspace
  await page.keyboard.press("Shift+d");
  await page.waitForTimeout(500);
  await page.locator("button").filter({ hasText: "Chat App" }).first().click();
  await page.waitForTimeout(1_500);

  // Beat 5: Open help overlay
  await page.locator("body").click();
  await page.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "?", bubbles: true }),
    );
  });
  await page.waitForSelector('text="Keyboard Shortcuts"', { timeout: 5_000 });
  await page.waitForTimeout(1_000);

  // Screenshot: help overlay
  await page.screenshot({
    path: "../docs/assets/web-help.png",
    fullPage: false,
  });

  // Beat 6: Close help
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1_000);
});
