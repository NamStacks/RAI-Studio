import fs from 'fs';
import path from 'path';
import { test, expect } from '@fixtures/rstudio.fixture';
import { executeCommand, getChatState } from '@utils/commands';
import { sandboxHome, setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

async function openSettings(page: any, fixture: { projectFile: string; projectPath: string }) {
  await page.evaluate((file: string) => (window as any).rstudio.project.open(file), fixture.projectFile);
  await page.waitForFunction(({ projectPath }: { projectPath: string }) => (window as any).rstudio?.ready === true &&
    (window as any).rstudio?.project?.path?.() === projectPath,
    { projectPath: fixture.projectPath }, { timeout: 60000 });
  await executeCommand(page, 'activateChat');
  await expect.poll(() => getChatState(page), { timeout: 60000 }).toBe('ready');
  const frame = page.frameLocator("iframe[title='RAI Assistant']");
  await page.getByRole('button', { name: 'RAI Assistant settings' }).click();
  await expect(frame.locator('#settings-panel')).toBeVisible();
  return frame;
}

test('Settings: every tab fits panes from 240 to 480 px wide without horizontal overflow @serial', async ({ rstudioPage: page }, testInfo) => {
  test.setTimeout(180000);
  const fixture = await setupScriptedRaiTest('settings-widths', 'fake-claude-provider-scoped-media.mjs', {});
  try {
    const frame = await openSettings(page, fixture);
    const panel = frame.locator('#settings-panel');
    for (const width of [240, 280, 360, 480]) {
      await page.evaluate((w: number) => {
        const element = document.querySelector("iframe[title='RAI Assistant']") as HTMLElement;
        element.style.width = `${w}px`;
        element.style.maxWidth = `${w}px`;
      }, width);
      for (const tab of ['general', 'global', 'snippets']) {
        await frame.locator(`#settings-tab-${tab}`).click();
        await expect.poll(() => frame.locator('body').evaluate(() => window.innerWidth), { timeout: 10000 }).toBeLessThanOrEqual(width + 2);
        const overflow = await panel.evaluate((element: HTMLElement) => {
          const body = element.querySelector('[role="tabpanel"]:not([hidden])') as HTMLElement;
          const box = element.getBoundingClientRect();
          const wide = Array.from(element.querySelectorAll('button, input, textarea, label, p, div'))
            .filter(node => (node as HTMLElement).offsetParent !== null)
            .filter(node => { const r = node.getBoundingClientRect(); return r.right > box.right + 1 || r.left < box.left - 1; })
            .map(node => `${node.tagName}#${(node as HTMLElement).id || ''}.${(node as HTMLElement).className}`);
          return { panelX: element.scrollWidth - element.clientWidth, bodyX: body.scrollWidth - body.clientWidth, wide };
        });
        expect(overflow.panelX, `${tab} @${width}: panel scrolls sideways`).toBeLessThanOrEqual(1);
        expect(overflow.bodyX, `${tab} @${width}: tab body scrolls sideways`).toBeLessThanOrEqual(1);
        expect(overflow.wide, `${tab} @${width}: elements outside the panel`).toEqual([]);
        await panel.screenshot({ path: testInfo.outputPath(`settings-${tab}-${width}.png`) });
      }
    }
  } finally {
    await teardownScriptedRaiTest(page, fixture.stateDir);
  }
});

test('Settings: Save with an unreachable bridge says so and keeps the draft @serial', async ({ rstudioPage: page }) => {
  test.setTimeout(180000);
  const fixture = await setupScriptedRaiTest('settings-bridge-down', 'fake-claude-provider-scoped-media.mjs', {});
  try {
    const frame = await openSettings(page, fixture);
    await frame.locator('#settings-fontsize-12').click();
    const raiDir = path.join(sandboxHome(), '.raistudio');
    const pids = fs.readdirSync(raiDir).filter(name => /^bridge-\d+\.port$/.test(name))
      .map(name => Number(fs.readFileSync(path.join(raiDir, name), 'utf8').trim().split(/\s+/)[1]))
      .filter(pid => Number.isInteger(pid) && pid > 0);
    expect(pids.length, 'a sandbox bridge is running').toBeGreaterThan(0);
    for (const pid of pids) process.kill(pid, 'SIGKILL');
    await frame.locator('#settings-save').click();
    await expect(frame.locator('#settings-error')).toBeVisible({ timeout: 30000 });
    // rsession may or may not have restarted the bridge yet: a dead bridge is 'not responding', a new one rejects the old token.
    await expect(frame.locator('#settings-error')).toContainText(/not responding|restarted/);
    await expect(frame.locator('#settings-error')).not.toContainText('Could not save settings');
    await expect(frame.locator('#settings-panel')).toBeVisible();
    await expect(frame.locator('#settings-fontsize-12')).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await teardownScriptedRaiTest(page, fixture.stateDir);
  }
});
