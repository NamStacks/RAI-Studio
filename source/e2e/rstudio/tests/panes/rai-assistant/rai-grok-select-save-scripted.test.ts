import { test, expect } from '@fixtures/rstudio.fixture';
import { executeCommand, getChatState } from '@utils/commands';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

test('Settings: selecting Grok Build and saving is accepted by the native session @serial', async ({ rstudioPage: page }) => {
  test.setTimeout(120000);
  const fixture = await setupScriptedRaiTest('grok-select-save', 'fake-claude-provider-scoped-media.mjs', {});
  try {
    await page.evaluate(file => (window as any).rstudio.project.open(file), fixture.projectFile);
    await page.waitForFunction(({ projectPath }) => (window as any).rstudio?.ready === true &&
      (window as any).rstudio?.project?.path?.() === projectPath,
      { projectPath: fixture.projectPath }, { timeout: 60000 });
    await executeCommand(page, 'activateChat');
    await expect.poll(() => getChatState(page), { timeout: 60000 }).toBe('ready');
    const frame = page.frameLocator("iframe[title='RAI Assistant']");
    const panel = frame.locator('#settings-panel');
    await page.getByRole('button', { name: 'RAI Assistant settings' }).click();
    await expect(panel).toBeVisible();
    await frame.locator('#settings-provider-list .native-cli', { hasText: 'Grok Build' }).click();
    await expect(frame.locator('#settings-provider-list .native-cli[data-provider="grok"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(frame.locator('#settings-provider')).toHaveValue('grok');
    await frame.locator('#settings-save').click();
    await expect(frame.locator('#settings-error')).toBeHidden(); // The old build answered 400 "unknown provider".
    await expect(panel).toBeHidden({ timeout: 30000 });
    await page.getByRole('button', { name: 'RAI Assistant settings' }).click();
    await expect(frame.locator('#settings-provider-list .native-cli[data-provider="grok"]')).toHaveAttribute('aria-pressed', 'true'); // Saved, not reverted.
    await expect(frame.locator('#settings-provider')).toHaveValue('grok');
  } finally {
    await teardownScriptedRaiTest(page, fixture.stateDir);
  }
});
