import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { executeCommand, getChatState } from '@utils/commands';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

const SENTINEL = 'RAI_RESTART_APPROVED=42';
const CODE = `{ value <- 40L + 2L; cat('${SENTINEL}\\n') }`;

test.describe('RAI Assistant recovery after Restart R + Run All Chunks', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.beforeEach(async () => {
    raiTest = await setupScriptedRaiTest(
      'restart-recovery',
      'fake-claude-provider-matrix.mjs',
      {
        'restart-recovery.Rmd': "```{r}\ncat('RAI_RESTART_CHUNK=ok\\n')\n```\n",
      },
      {
        waitForFile: 'post-restart',
        proposals: [{ language: 'R', target: 'console', code: CODE }],
      },
    );
  });

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('keeps RAI ready and approval-gated after restart and chunk execution', async ({ rstudioPage: page }) => {
    test.setTimeout(180000);
    await page.evaluate((projectFile) => (window as any).rstudio.project.open(projectFile), raiTest!.projectFile);
    await page.waitForFunction(
      ({ projectPath }) => (window as any).rstudio?.ready === true &&
        (window as any).rstudio?.project?.path?.() === projectPath,
      { projectPath: raiTest!.projectPath }, { timeout: 30000 },
    );

    const rmdPath = path.join(path.dirname(raiTest!.projectFile), 'restart-recovery.Rmd');
    await page.evaluate((file) => (window as any).rstudio.documents.open(file), rmdPath);
    const consoleActions = new ConsolePaneActions(page);
    await consoleActions.clearConsole();

    await executeCommand(page, 'activateChat');
    const frame = page.locator("iframe[title='RAI Assistant']");
    await expect(frame).toBeVisible({ timeout: 15000 });
    await expect.poll(() => getChatState(page), { timeout: 60000, intervals: [1000] }).toBe('ready');
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);

    const restartBegan = page.waitForFunction(() => (window as any).rstudio?.ready === false, null, { timeout: 30000 });
    await executeCommand(page, 'restartRRunAllChunks');
    await restartBegan;
    await expect(consoleActions.consolePane.consoleOutput).toContainText('RAI_RESTART_CHUNK=ok', { timeout: 60000 });
    await page.waitForFunction(() => (window as any).rstudio?.ready === true, null, { timeout: 30000 });
    await expect.poll(() => getChatState(page), { timeout: 60000, intervals: [1000] }).toBe('ready');

    fs.writeFileSync(path.join(raiTest!.stateDir, 'post-restart'), 'ready');
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);
    await expect(frame).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => (await frame.boundingBox())?.width ?? 0).toBeGreaterThan(100);
    await expect.poll(async () => (await frame.boundingBox())?.height ?? 0).toBeGreaterThan(100);
    await expect(consoleActions.consolePane.consoleOutput).toContainText(SENTINEL, { timeout: 15000 });

    await expect.poll(() => {
      const file = path.join(raiTest!.stateDir, 'results.json');
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    }, { timeout: 15000, intervals: [500] }).toMatchObject([
      { proposal: { code: CODE }, result: { status: 'ok', stdout: expect.stringContaining(SENTINEL) } },
    ]);
  });
});

