import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import type { Page } from 'playwright';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { documentOpen, executeCommand, getChatState } from '@utils/commands';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

// Regression guard for an R session recycle landing in the MIDDLE of a
// chunk-by-chunk audit. rai-restart-recovery-scripted.test.ts already proves
// the Assistant stays alive and approval-gated across Restart R + Run All
// Chunks, but it restarts BEFORE any audit work exists, so nothing it asserts
// could catch the failure that actually matters here: an audit that keeps
// reasoning from pre-restart state after the session under it was replaced.
//
// Two stale-state hazards, both covered:
//
//   1. A run_id from the old session must not replay its old stored result.
//   2. A .GlobalEnv binding created by a Console run in the old session must
//      be reported as the NEW session actually finds it -- never cached.
//
// OBSERVED BEHAVIOR, asserted here rather than assumed. Hazard 2 is pinned
// against ground truth instead of against a guess about restart semantics:
// the same question is asked through get_environment_summary AND by running
// exists() in the live Console, and the two must agree. A cached answer would
// diverge from the Console; a live one cannot. The test additionally asserts
// the specific outcome this build produces, so a future change in restart
// semantics surfaces as a failure rather than passing silently.
//
// The chunk marker is the control: it is created only by the .Rmd chunk that
// Restart R + Run All Chunks re-executes, so its presence proves the recycle
// really happened and the new session really ran the document.
const CHUNK_MARKER_SENTINEL = 'RAI_RECYCLE_CHUNK_RAN';
const RMD_SOURCE =
  '```{r}\n' +
  `rai_recycle_chunk <- 'ran'\n` +
  `cat('${CHUNK_MARKER_SENTINEL}\\n')\n` +
  '```\n';

type SessionRecycleData = {
  step_log: Array<Record<string, unknown>>;
  pre_run_id: string;
  pre_run_result: { status: string; stdout?: string };
  environment_before: Record<string, boolean>;
  stale_run_read: { status: string; message?: string; stdout?: string };
  environment_after: Record<string, boolean>;
  console_truth: Record<string, boolean>;
  console_probe_stdout: string | null;
  environment_agrees_with_console: boolean;
};

function readData(file: string): SessionRecycleData | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as SessionRecycleData : null;
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

test.describe('RAI Assistant session recycle mid-audit (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('reports post-recycle state from the live session, never from pre-restart run results or cached bindings', async ({ rstudioPage: page }) => {
    test.setTimeout(240000);

    raiTest = await setupScriptedRaiTest(
      'session-recycle',
      'fake-claude-provider-session-recycle.mjs',
      { 'recycle.Rmd': RMD_SOURCE },
      undefined,
      true,
    );

    await openScenarioProject(page, raiTest);

    const rmdPath = path.join(path.dirname(raiTest.projectFile), 'recycle.Rmd');
    await documentOpen(page, rmdPath);
    const consoleActions = new ConsolePaneActions(page);
    await consoleActions.clearConsole();

    await openAssistant(page);
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);

    // --- Wait until the audit has genuinely produced state worth losing:
    // the fixture only writes this once its first chunk ran and its binding
    // was confirmed. Restarting earlier would test nothing. ------------------
    const checkpoint = path.join(raiTest.stateDir, 'audit-checkpoint');
    await expect.poll(() => fs.existsSync(checkpoint), { timeout: 120000, intervals: [500] }).toBe(true);

    // --- Recycle the session underneath the in-progress audit, using the
    // same native automation command as rai-restart-recovery. ---------------
    const restartBegan = page.waitForFunction(() => (window as any).rstudio?.ready === false, null, { timeout: 60000 });
    await executeCommand(page, 'restartRRunAllChunks');
    await restartBegan;
    await expect(consoleActions.consolePane.consoleOutput)
      .toContainText(CHUNK_MARKER_SENTINEL, { timeout: 90000 });
    await page.waitForFunction(() => (window as any).rstudio?.ready === true, null, { timeout: 60000 });
    await expect.poll(() => getChatState(page), { timeout: 60000, intervals: [1000] }).toBe('ready');

    fs.writeFileSync(path.join(raiTest.stateDir, 'post-restart'), 'ready');

    const dataFile = path.join(raiTest.stateDir, 'session-recycle-data.json');
    await expect.poll(() => readData(dataFile), { timeout: 150000, intervals: [1000] }).not.toBeNull();
    const data = readData(dataFile)!;
    // The sandbox is removed by globalTeardown, so copy the MCP transcript
    // this asserts on into the run's artifacts before it disappears.
    const evidence = test.info().outputPath('session-recycle-data.json');
    fs.copyFileSync(dataFile, evidence);
    await test.info().attach('session-recycle-data.json', { path: evidence, contentType: 'application/json' });

    // --- The audit really had live state before the recycle. ---------------
    expect(data.pre_run_result.status).toBe('ok');
    expect(data.environment_before).toEqual({ rai_recycle_console: true, rai_recycle_chunk: false });

    // --- Control: the recycle genuinely happened and the NEW session ran the
    // document, so the chunk-created binding is present afterwards. ---------
    expect(data.console_truth.rai_recycle_chunk).toBe(true);

    // --- Hazard 1: the pre-restart run_id does not replay its old result. --
    expect(data.stale_run_read.status).not.toBe('ok');
    expect(data.stale_run_read.status).toBe('session_restarted');
    expect(data.stale_run_read.stdout).toBeUndefined();

    // --- Hazard 2: the Console-created binding did not survive the recycle,
    // and is reported as gone rather than served from a cache. -------------
    expect(data.console_truth.rai_recycle_console).toBe(false);
    expect(data.environment_after.rai_recycle_console).toBe(false);

    // --- The invariant behind hazard 2: MCP's view and the live Console's
    // own view of .GlobalEnv agree exactly, so the report is live state and
    // not a carried-over answer. -------------------------------------------
    expect(data.environment_agrees_with_console).toBe(true);
    expect(data.environment_after).toEqual(data.console_truth);
    expect(data.console_probe_stdout).toContain('RAI_RECYCLE_PROBE FALSE TRUE');

    // --- Ordering: every post-recycle read happened after the checkpoint,
    // nothing was answered from before the restart. -------------------------
    expect(data.step_log.map((entry) => entry.step)).toEqual([
      'pre-restart-run', 'stale-run-read', 'environment-after', 'console-probe',
    ]);
  });
});
