import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import { executeCommand, getChatState } from '@utils/commands';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

test.describe('RAI scoped reviews and validated terminal images @serial', () => {
  let stateDir: string | undefined;
  test.afterEach(async ({ rstudioPage: page }) => { await teardownScriptedRaiTest(page, stateDir); });

  for (const [kind, label, marker] of [
    ['writing', 'Writing review', 'Make this writing clearer without changing its meaning.'],
    ['analysis', 'Analysis review', 'Check the analysis and flag unsupported conclusions.'],
  ] as const) {
    test(`${label} is a user-invoked draft; embedded image bytes render without a remote fetch`, async ({ rstudioPage: page }) => {
      test.setTimeout(120000);
      const fixture = await setupScriptedRaiTest(`scoped-media-${kind}`, 'fake-claude-provider-scoped-media.mjs', {});
      stateDir = fixture.stateDir;
      const unexpected: string[] = [];
      page.on('request', request => {
        if (request.url().includes('malicious.invalid')) unexpected.push(request.url());
      });
      await page.evaluate(file => { (window as any).rstudio.project.open(file); }, fixture.projectFile);
      await page.waitForFunction(({ projectPath }) => (window as any).rstudio?.ready === true &&
        (window as any).rstudio?.project?.path?.() === projectPath, { projectPath: fixture.projectPath }, { timeout: 60000 });
      await executeCommand(page, 'activateChat');
      await expect.poll(() => getChatState(page), { timeout: 60000, intervals: [1000] }).toBe('ready');
      const frame = page.frameLocator("iframe[title='RAI Assistant']");
      const button = frame.getByRole('button', { name: label });
      await expect(button).toBeEnabled({ timeout: 30000 });
      await expect.poll(() => frame.locator('body').evaluate(() => (window as any).__raiComposerReady === true), { timeout: 30000 }).toBe(true);
      await expect.poll(() => frame.locator('#term').evaluate(() =>
        (window as any).__raiImageAddonReady === true &&
        (window as any).__raiImageAddon?.storageUsage > 0),
        { timeout: 15000 }).toBe(true);
      const usage = await frame.locator('#term').evaluate(() => (window as any).__raiImageAddon.storageUsage as number);
      expect(usage).toBeGreaterThan(0);
      await button.click();
      await expect(button).toBeEnabled();
      await expect(frame.locator('#scoped-guidance-status')).toContainText('Not sent');
      await expect(frame.locator('#pending-draft')).toBeHidden();
      const input = path.join(fixture.stateDir, 'draft-input.bin');
      await expect.poll(() => fs.existsSync(input) ? fs.readFileSync(input, 'utf8') : '',
        { timeout: 15000 }).toContain(marker);
      const bytes = fs.readFileSync(input);
      const draft = bytes.toString('utf8');
      expect(bytes.includes(13)).toBe(false); // No Enter/CR or auto-submission.
      expect(draft).toBe(marker); // One-line snippet text is inserted as itself.
      expect(draft).not.toContain('User-invoked'); // No pretend policy preamble.
      expect(unexpected).toEqual([]);
    });
  }
});

