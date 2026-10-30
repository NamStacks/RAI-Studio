import { test, expect } from '@fixtures/rstudio.fixture';
import { executeCommand, getChatState } from '@utils/commands';

// Provider and approval policy live in the Assistant iframe, not a GWT dialog.
// Cancel closes the panel; this test does not save.
test('RAI Assistant settings displays provider and execution policy without saving', async ({ rstudioPage: page }) => {
  await executeCommand(page, 'activateChat');
  await expect.poll(() => getChatState(page), { timeout: 60000, intervals: [1000] }).toBe('ready');
  const frame = page.frameLocator("iframe[title='RAI Assistant']");
  const panel = frame.locator('#settings-panel');
  await page.getByRole('button', { name: 'RAI Assistant settings' }).click();
  await expect(panel).toBeVisible();
  await expect(panel.locator('#settings-provider-list .native-cli[aria-pressed="true"]')).toBeVisible();
  await expect(panel.locator('#settings-general select')).toHaveCount(0);
  await expect(panel.locator('#settings-save-on-edit')).toHaveCount(0);
  await expect(panel.getByText('Keep Mac Awake')).toBeVisible();
  await expect(panel.locator('#settings-rai-policy-hint')).toHaveText(
    /Valid RAI tool actions are approved automatically/,
  );
  await frame.locator('#settings-cancel').click();
  await expect(panel).toBeHidden();
});

