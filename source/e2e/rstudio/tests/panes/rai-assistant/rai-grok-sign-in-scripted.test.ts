import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import { executeCommand, getChatState } from '@utils/commands';
import { sandboxHome, setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

test('Grok: an existing login opens the terminal, and the session launches with --trust and no --add-dir @serial', async ({ rstudioPage: page }) => {
  test.setTimeout(180000);
  // A fixture login: an account with a non-empty auth_mode is what counts as signed in.
  const grokDir = path.join(sandboxHome(), '.grok');
  fs.mkdirSync(grokDir, { recursive: true });
  fs.writeFileSync(path.join(grokDir, 'auth.json'), JSON.stringify({ 'fixture-account': { auth_mode: 'fixture' } }), { mode: 0o600 });
  const fixture = await setupScriptedRaiTest('grok-sign-in', 'fake-grok-provider.mjs', {}, undefined, false, 'grok');
  const launches = () => {
    const file = path.join(fixture.stateDir, 'grok-launches.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  };
  try {
    await page.evaluate(file => (window as any).rstudio.project.open(file), fixture.projectFile);
    await page.waitForFunction(({ projectPath }) => (window as any).rstudio?.ready === true &&
      (window as any).rstudio?.project?.path?.() === projectPath,
      { projectPath: fixture.projectPath }, { timeout: 60000 });
    await executeCommand(page, 'activateChat');
    await expect.poll(() => getChatState(page), { timeout: 60000 }).toBe('ready');
    await expect.poll(() => launches().length, { timeout: 30000 }).toBeGreaterThanOrEqual(1);

    const frame = page.frameLocator("iframe[title='RAI Assistant']");
    await page.getByRole('button', { name: 'RAI Assistant settings' }).click();
    await expect(frame.locator('#settings-panel')).toBeVisible();
    await expect(frame.locator('#settings-provider-list .native-cli[data-provider="grok"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(frame.locator('#settings-provider')).toHaveValue('grok');
    const before = launches().length;
    await frame.locator('#settings-sign-in-provider').click();
    await expect(frame.locator('#term-status')).toContainText('already signed in', { timeout: 30000 });
    await expect.poll(() => launches().length, { timeout: 30000 }).toBeGreaterThan(before); // Reopened the terminal, did not run grok login.

    for (const launch of launches()) {
      expect(launch.argv).toContain('--trust');
      expect(launch.argv).not.toContain('--add-dir');
      expect(launch.argv).not.toContain('login');
      const cwd = launch.argv[launch.argv.indexOf('--cwd') + 1];
      expect(fs.realpathSync(cwd)).toBe(fs.realpathSync(launch.cwd));
      expect(cwd).toContain(`${path.sep}.raistudio${path.sep}grok-sessions${path.sep}`);
      expect(path.basename(cwd)).toBe('session'); // Fixed per project, so --continue finds earlier sessions.
      expect(fs.realpathSync(launch.projectLink)).toBe(fs.realpathSync(path.dirname(fixture.projectFile)));
      expect(launch.mcpEntry).toBe(true);
      expect(launch.tokenInEnv).toBe(false);
    }
  } finally {
    await teardownScriptedRaiTest(page, fixture.stateDir);
    fs.rmSync(path.join(sandboxHome(), '.grok'), { recursive: true, force: true });
  }
});
