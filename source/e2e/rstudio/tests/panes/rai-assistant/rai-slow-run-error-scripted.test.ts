import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import type { Page } from 'playwright';
import { executeCommand, getChatState } from '@utils/commands';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

// Regression guard: the async run_r/get_run_result polling contract must
// correctly distinguish "still running" from "failed" on a genuinely slow
// ERROR path, not just the slow success path covered by
// rai-slow-run-recovery-scripted.test.ts. A client that misread an early
// non-terminal read, or that stopped polling as soon as it saw anything
// other than "ok", could report a false failure or a false success here.

type PollEntry = { t_ms: number; status: string };

type SlowErrorData = {
  run_id: string;
  console_run_result: { status: string; stderr?: string };
  elapsed_ms: number;
  poll_log: PollEntry[];
  first_read_status: string;
};

function readData(file: string): SlowErrorData | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as SlowErrorData : null;
}

async function openAssistant(page: Page): Promise<void> {
  await executeCommand(page, 'activateChat');
  await expect(page.locator("iframe[title='RAI Assistant']")).toBeVisible({ timeout: 15000 });
  await expect.poll(() => getChatState(page), { timeout: 60000, intervals: [1000] }).toBe('ready');
}

async function openScenarioProject(
  page: Page,
  raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>>,
): Promise<void> {
  await page.evaluate((projectFile) => { (window as any).rstudio.project.open(projectFile); }, raiTest.projectFile);
  await page.waitForFunction(
    ({ expectedProjectPath }) => (window as any).rstudio?.ready === true &&
      (window as any).rstudio?.project?.path?.() === expectedProjectPath,
    { expectedProjectPath: raiTest.projectPath },
    { timeout: 60000 },
  );
}

test.describe('RAI Assistant slow Console run error path (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('polls a genuinely slow run that errors, and settles to error only after the sleep actually elapsed', async ({ rstudioPage: page }) => {
    test.setTimeout(150000);

    raiTest = await setupScriptedRaiTest(
      'slow-run-error',
      'fake-claude-provider-slow-run-error.mjs',
      {},
      undefined,
      true,
    );

    await openScenarioProject(page, raiTest);
    await openAssistant(page);

    const approvalCard = page.locator('.rai-approval-card');
    await expect(approvalCard).toHaveCount(0);

    const dataFile = path.join(raiTest.stateDir, 'slow-error-data.json');
    await expect.poll(() => readData(dataFile), { timeout: 130000, intervals: [1000] }).not.toBeNull();
    const data = readData(dataFile)!;

    // --- The first status read was genuinely non-terminal. -------------------
    expect(['pending', 'running']).toContain(data.first_read_status);
    expect(data.poll_log.length).toBeGreaterThan(1);

    // --- Polling correctly settled to "error", not "ok" and not stuck. -------
    expect(data.poll_log[data.poll_log.length - 1].status).toBe('error');
    expect(data.console_run_result.status).toBe('error');

    // --- The run only settled after its own Sys.sleep actually elapsed --
    // proves the error was not reported prematurely from a stale/short
    // read. ---------------------------------------------------------------
    expect(data.elapsed_ms).toBeGreaterThanOrEqual(5000);

    // --- The captured error is the real R stop() message, not a generic/
    // wrong failure. --------------------------------------------------------
    expect(data.console_run_result.stderr).toContain('rai_slow_error_boom');

    // --- The real Console pane agrees: the error text is visible natively,
    // not just via the MCP transcript. ---------------------------------------
    const chatState = await getChatState(page);
    expect(chatState).toBe('ready');
  });
});
