import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import { executeCommand, getChatState } from '@utils/commands';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

const PROJECT_READY_TIMEOUT_MS = 60000;

// Proves full auto-approval against the real signed package: every parser-valid
// R proposal executes with no approval card when autoApproveReadOnly is enabled.
// Strict non-R/Markdown payload validation remains separately covered before a
// proposal reaches the native session.
function writeAutoApproveSetting(stateDir: string, enabled: boolean): void {
  const raiDir = path.join(path.dirname(path.dirname(path.dirname(stateDir))), '.raistudio');
  const configFile = path.join(raiDir, 'assistant.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.autoApproveReadOnly = enabled;
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
}

test.describe('RAI Assistant scoped auto-approval (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.afterEach(async ({ rstudioPage: page }) => {
    if (raiTest) writeAutoApproveSetting(raiTest.stateDir, false);
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('a safe read-only proposal executes without an approval card when enabled', async ({ rstudioPage: page }) => {
    test.setTimeout(120000);
    raiTest = await setupScriptedRaiTest('auto-approve-safe', 'fake-claude-provider-matrix.mjs', {}, {
      proposals: [{ language: 'R', target: 'console', code: '20 + 22' }],
    });
    writeAutoApproveSetting(raiTest.stateDir, true);

    await page.evaluate((projectFile) => (window as any).rstudio.project.open(projectFile), raiTest!.projectFile);
    await page.waitForFunction(
      ({ projectPath }) => (window as any).rstudio?.ready === true &&
        (window as any).rstudio?.project?.path?.() === projectPath,
      { projectPath: raiTest!.projectPath }, { timeout: PROJECT_READY_TIMEOUT_MS },
    );

    const consoleActions = new ConsolePaneActions(page);
    await consoleActions.clearConsole();
    await executeCommand(page, 'activateChat');
    await expect(page.locator("iframe[title='RAI Assistant']")).toBeVisible({ timeout: 15000 });
    await expect.poll(() => getChatState(page), { timeout: 60000, intervals: [1000] }).toBe('ready');

    // No approval card should ever appear for this proposal.
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);

    await expect(consoleActions.consolePane.consoleOutput).toContainText('[1] 42', { timeout: 20000 });
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);

    const resultFile = path.join(raiTest.stateDir, 'results.json');
    await expect.poll(
      () => fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null,
      { timeout: 15000, intervals: [500] },
    ).toMatchObject([{ result: { status: 'ok', stdout: expect.stringContaining('[1] 42') } }]);
  });

  test('a parser-valid side-effecting proposal also executes without a card when enabled', async ({ rstudioPage: page }) => {
    test.setTimeout(120000);
    raiTest = await setupScriptedRaiTest('auto-approve-side-effect', 'fake-claude-provider-matrix.mjs', {}, {
      proposals: [{ language: 'R', target: 'console', code: "cat('RAI_AUTO_APPROVE_SIDE_EFFECT\\n')" }],
    });
    writeAutoApproveSetting(raiTest.stateDir, true);

    await page.evaluate((projectFile) => (window as any).rstudio.project.open(projectFile), raiTest!.projectFile);
    await page.waitForFunction(
      ({ projectPath }) => (window as any).rstudio?.ready === true &&
        (window as any).rstudio?.project?.path?.() === projectPath,
      { projectPath: raiTest!.projectPath }, { timeout: PROJECT_READY_TIMEOUT_MS },
    );

    const consoleActions = new ConsolePaneActions(page);
    await consoleActions.clearConsole();
    await executeCommand(page, 'activateChat');
    await expect(page.locator("iframe[title='RAI Assistant']")).toBeVisible({ timeout: 15000 });
    await expect.poll(() => getChatState(page), { timeout: 60000, intervals: [1000] }).toBe('ready');

    await expect(page.locator('.rai-approval-card')).toHaveCount(0);
    await expect(consoleActions.consolePane.consoleOutput).toContainText('RAI_AUTO_APPROVE_SIDE_EFFECT', { timeout: 15000 });
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);
  });

  test('Reset Assistant starts a fresh terminal session and leaves no approval card', async ({ rstudioPage: page }) => {
    test.setTimeout(120000);
    raiTest = await setupScriptedRaiTest('reset-clears-approval', 'fake-claude-provider-editor-edit.mjs', {
      'analysis.R': "threshold <- 0.05\nmessage('keep this line')\n",
    });

    await page.evaluate((projectFile) => (window as any).rstudio.project.open(projectFile), raiTest.projectFile);
    await page.waitForFunction(
      ({ projectPath }) => (window as any).rstudio?.ready === true &&
        (window as any).rstudio?.project?.path?.() === projectPath,
      { projectPath: raiTest.projectPath }, { timeout: PROJECT_READY_TIMEOUT_MS },
    );
    await page.evaluate((file) => (window as any).rstudio.documents.open(file),
      path.join(path.dirname(raiTest.projectFile), 'analysis.R'));
    await executeCommand(page, 'activateChat');

    const approvalCard = page.locator('.rai-approval-card');
    await expect(approvalCard).toHaveCount(0);
    await page.getByTitle('Reset Assistant', { exact: true }).click();
    await expect(approvalCard).toHaveCount(0);
    await expect.poll(() => getChatState(page), { timeout: 60000, intervals: [1000] }).toBe('ready');

    const frame = page.frameLocator("iframe[title='RAI Assistant']");
    await expect(frame.locator('#term')).toBeVisible({ timeout: 30000 });
  });

  // The autonomy scope supersedes the per-edit Allow-once requirement for
  // Full Auto: an exact edit applies without a card. The manual card path is
  // still covered with Full Auto disabled in rai-editor-edit-scripted.test.ts.
  test('document edits apply without an approval card when Full Auto is enabled', async ({ rstudioPage: page }) => {
    test.setTimeout(120000);
    raiTest = await setupScriptedRaiTest('auto-approve-editor', 'fake-claude-provider-editor-edit.mjs', {
      'analysis.R': "threshold <- 0.05\nmessage('keep this line')\n",
    }, { mode: 'expect_full_auto' });
    writeAutoApproveSetting(raiTest.stateDir, true);

    await page.evaluate((projectFile) => (window as any).rstudio.project.open(projectFile), raiTest!.projectFile);
    await page.waitForFunction(
      ({ projectPath }) => (window as any).rstudio?.ready === true &&
        (window as any).rstudio?.project?.path?.() === projectPath,
      { projectPath: raiTest!.projectPath }, { timeout: PROJECT_READY_TIMEOUT_MS },
    );

    await page.evaluate((file) => (window as any).rstudio.documents.open(file),
      path.join(path.dirname(raiTest!.projectFile), 'analysis.R'));
    await executeCommand(page, 'activateChat');
    await expect(page.locator("iframe[title='RAI Assistant']")).toBeVisible({ timeout: 15000 });

    const resultFile = path.join(raiTest!.stateDir, 'result.json');
    await expect.poll(
      () => fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null,
      { timeout: 30000, intervals: [500] },
    ).toMatchObject({ status: 'applied', approval: 'autonomous', expected_text: 'threshold <- 0.05',
                      replacement: 'threshold <- 0.01', buffer_has_replacement: true });
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);
  });
});
