import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import { executeCommand, getChatState } from '@utils/commands';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

const DECLINE_R_CODE = 'Sys.sleep(30)';

// Stage 0A also requires proving the inverse of the approved round trip:
// declining a proposed run must leave the Console untouched -- zero new
// input, not even the raw proposed source. Reuses the same deterministic
// fake-provider harness as rai-console-roundtrip-scripted.test.ts (see that
// file's header comment for what it exercises) but this run_r proposal is
// never allowed, so the provider keeps the pending request open until the
// test declines it.
test.describe('RAI Assistant console round trip (scripted provider) -- declined approval', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.beforeEach(async () => {
    raiTest = await setupScriptedRaiTest('decline', 'fake-claude-provider-decline.mjs', {});
  });

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('declining the approval card leaves the Console with zero new input', async ({ rstudioPage: page }) => {
    test.setTimeout(90000);

    // ApplicationAutomation.project.path() returns the active .Rproj file,
    // but in the session's home-relative form (~/...), while the host-side
    // fixture needs the absolute filename to open it. Wait for the new
    // session lifecycle first, then assert the bridge's canonical identity.
    await page.evaluate((projectFile) => {
      (window as any).rstudio.project.open(projectFile);
    }, raiTest!.projectFile);
    await page.waitForFunction(
      ({ projectPath }) => (window as any).rstudio?.ready === true &&
        (window as any).rstudio?.project?.path?.() === projectPath,
      { projectPath: raiTest!.projectPath },
      { timeout: 30000 },
    );

    const consoleActions = new ConsolePaneActions(page);
    await consoleActions.clearConsole();
    const baselineConsoleText = await consoleActions.consolePane.consoleOutput.innerText();

    await executeCommand(page, 'activateChat');
    await expect(page.locator("iframe[title='RAI Assistant']")).toBeVisible({ timeout: 15000 });
    await expect.poll(() => getChatState(page), { timeout: 60000, intervals: [1000] }).toBe('ready');

    // Valid run_r is approved automatically. This proposal contains Sys.sleep,
    // which has no effect contract, so it is refused before the Console and
    // no approval card is shown.
    const approvalCard = page.locator('.rai-approval-card');
    await expect(approvalCard).toHaveCount(0);
    const resultFile = path.join(raiTest!.stateDir, 'decline-result.json');
    await expect.poll(
      () => fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null,
      { timeout: 30000, intervals: [500] },
    ).toMatchObject({ status: 'error' });
    const refused = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    expect(JSON.stringify(refused)).toMatch(/no approved effect contract/);
    expect(refused.run_id).toBeUndefined();

    // Leave enough time for any incorrect Console routing to become visible.
    await page.waitForTimeout(6000);

    const afterDeclineConsoleText = await consoleActions.consolePane.consoleOutput.innerText();
    expect(afterDeclineConsoleText).toBe(baselineConsoleText);
    expect(afterDeclineConsoleText).not.toContain(DECLINE_R_CODE);
    expect(afterDeclineConsoleText).not.toContain('THIS_MUST_NEVER_REACH_THE_CONSOLE');
  });
});
