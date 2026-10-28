import { test, expect } from '@fixtures/rstudio.fixture';
import { executeCommand } from '@utils/commands';

// Compile-and-smoke check for the new "keep terminal awake" (caffeinate)
// toolbar checkbox: activates the RAI Assistant pane and asserts the
// LatchingToolbarButton renders, defaults to checked (aria-pressed=true via
// the toolbarButtonLatched style), and toggles on click. This forces a real
// GWT compile of ChatPane/ChatPresenter/StandardIcons -- if any of those
// don't build, this test fails at the desktop-dev build step before a
// single assertion runs.
test.describe('RAI Assistant caffeinate toolbar checkbox', () => {
  test('renders, defaults checked, and toggles on click', async ({ rstudioPage: page }) => {
    test.setTimeout(60000);

    await executeCommand(page, 'activateChat');

    const caffeinateButton = page.locator('[class*="rai_caffeinate_toggle"], .rai_caffeinate_toggle').first();
    // Fall back to a title-based locator in case the classId selector
    // doesn't match GWT's generated attribute shape.
    const button = (await caffeinateButton.count()) > 0
      ? caffeinateButton
      : page.getByTitle(/keep terminal awake/i);

    await expect(button).toBeVisible({ timeout: 20000 });

    // Default state: latched (checked). GWT obfuscates CSS class names in
    // this build, so assert on aria-pressed (LatchingToolbarButton sets
    // this explicitly) rather than a literal toolbarButtonLatched string.
    await expect(button).toHaveAttribute('aria-pressed', 'true');

    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'false');

    // Toggle back so the setting isn't left disabled for any other test
    // that reuses this profile/session.
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  });
});
