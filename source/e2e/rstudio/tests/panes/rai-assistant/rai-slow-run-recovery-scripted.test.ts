import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import type { Page } from 'playwright';
import { executeCommand, getChatState } from '@utils/commands';
import { EnvironmentPane } from '@pages/environment_pane.page';
import { TIMEOUTS } from '@utils/constants';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

// Regression guard for the async run_r/get_run_result polling contract under
// a genuinely slow Console computation. Proves: (1) the very first
// get_run_result read is non-terminal; (2) polling settles to "ok" only
// after the hold has elapsed; (3) the data frame is visible in the
// Environment pane. plot() stays refused by the effect contract.

type PollEntry = { t_ms: number; status: string };

type SlowRunData = {
  run_id: string;
  console_run_result: { status: string; stdout?: string };
  elapsed_ms: number;
  poll_log: PollEntry[];
  first_read_status: string;
  environment_detail: { objects: Array<{ name: string; found: boolean; dims?: number[]; row_count?: number }> };
  plot_attempt: { message?: string; run_id?: string };
  plot_image_present: boolean;
};

function readData(file: string): SlowRunData | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as SlowRunData : null;
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
  // The project path can become visible before the automation bridge finishes
  // restoring (window.rstudio.ready flips back to true only once R's deferred
  // init completes on the new project). Keep the canonical condition (path AND
  // ready===true, never weakened to path-only) but use a full session-start
  // window rather than a short generic wait, matching the documented
  // project-reinitialization readiness race in this suite.
  await page.waitForFunction(
    ({ expectedProjectPath }) => (window as any).rstudio?.ready === true &&
      (window as any).rstudio?.project?.path?.() === expectedProjectPath,
    { expectedProjectPath: raiTest.projectPath },
    { timeout: 60000 },
  );
}

test.describe('RAI Assistant slow Console run recovery (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('polls a genuinely slow run to completion, then confirms the environment and plot state it produced', async ({ rstudioPage: page }) => {
    test.setTimeout(180000);

    raiTest = await setupScriptedRaiTest(
      'slow-run-recovery',
      'fake-claude-provider-slow-run-recovery.mjs',
      {},
      undefined,
      true,
    );

    await openScenarioProject(page, raiTest);
    await openAssistant(page);

    const approvalCard = page.locator('.rai-approval-card');
    await expect(approvalCard).toHaveCount(0);

    const dataFile = path.join(raiTest.stateDir, 'slow-run-data.json');
    await expect.poll(() => readData(dataFile), { timeout: 150000, intervals: [1000] }).not.toBeNull();
    const data = readData(dataFile)!;

    // --- The core regression assertion: the first status read was
    // genuinely non-terminal (pending/running), proving this run could not
    // have been correctly resolved by a single get_run_result check. -------
    expect(['pending', 'running']).toContain(data.first_read_status);
    expect(data.poll_log.length).toBeGreaterThan(1);
    expect(data.poll_log[data.poll_log.length - 1].status).toBe('ok');

    // --- The run only settled after its own Sys.sleep actually elapsed. ---
    expect(data.elapsed_ms).toBeGreaterThanOrEqual(6000);

    // --- Console output is the expected data.frame print, not a stale/
    // partial read. ----------------------------------------------------------
    expect(data.console_run_result).toMatchObject({ status: 'ok' });
    expect(data.console_run_result.stdout).toContain('30');

    // --- Environment: the data frame created only after the sleep is
    // visible with the right shape via MCP, AND independently in the live
    // Environment pane. -------------------------------------------------------
    const dfEntry = data.environment_detail.objects.find((object) => object.name === 'rai_slow_df');
    expect(dfEntry?.found).toBe(true);
    expect(dfEntry?.dims).toEqual([3, 2]);
    expect(dfEntry?.row_count).toBe(3);
    const envPane = new EnvironmentPane(page);
    await executeCommand(page, 'activateEnvironment');
    await expect.poll(
      () => envPane.hasVariable('rai_slow_df', '3 obs.'),
      { timeout: TIMEOUTS.environmentUpdate, intervals: [TIMEOUTS.pollInterval] },
    ).toBe(true);

    // plot() is not an approved autonomous effect. The proposal is refused
    // and does not create a plot image.
    expect(data.plot_attempt.message).toMatch(/no approved effect contract/);
    expect(data.plot_attempt.run_id).toBeUndefined();
    expect(data.plot_image_present).toBe(false);
  });
});
