import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import type { Page } from 'playwright';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { executeCommand, getChatState } from '@utils/commands';
import { EnvironmentPane } from '@pages/environment_pane.page';
import { TIMEOUTS } from '@utils/constants';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

// Regression guard for an R session restart landing while a Console run is
// STILL IN FLIGHT. rai-session-recycle-mid-audit-scripted.test.ts restarts
// after a chunk completed and its result was already read, so the run it asks
// about is a settled record holding a stored result. That is the tidy case.
// This is the race: the run is registered, its code is executing (Sys.sleep
// holds the Console open), nothing has been polled to completion, and the
// session is pulled out from under it.
//
// Two hazards live here that the settled case cannot reach:
//
//   1. The in-flight run_id. Its code never finished and it has no result at
//      all -- not a stale one, none. get_run_result must say so promptly
//      rather than hang or invent a terminal status.
//   2. The capture slot. The killed run held it (RaiCaptureArmed/Capturing).
//      If a restart could leave the slot occupied, every later run_r in the
//      fresh session would answer "busy" forever and the Assistant's Console
//      path would be permanently wedged -- worse than a lost result, and
//      reachable only by restarting mid-run.
//
// OBSERVED BEHAVIOR, asserted here rather than assumed:
//
//   * get_run_result on the in-flight run_id answers "session_restarted".
//     The bridge (rai-native-mcp.js) remembers run_id -> session_id at queue
//     time and compares it against the live session id, so the answer comes
//     from the identity mismatch, never from the dead run's record.
//   * The slot is NOT wedged: a brand-new run in the fresh session queues and
//     completes normally.
//   * The interrupted binding does not exist, and MCP's view agrees exactly
//     with the live Console's own view of .GlobalEnv.
//
// Proving the race really happened is the delicate part: a restart that
// merely WAITED for R to go idle would look identical afterwards, because a
// restart clears .GlobalEnv either way and an absent binding proves nothing
// on its own. The discriminator is timing. The fixture confirms the run is
// non-terminal immediately before handing off, and this test records how long
// after that checkpoint the restart completed. The Sys.time hold began
// before the checkpoint, so a restart completing well inside that window can
// only have landed while the code was still executing. Retry/polling is used
// ONLY to confirm the restart itself happened and the endpoint came back --
// never around the assertions, which take the first genuine answer.

const HOLD_SECONDS = 90;
// Generous relative to an observed restart (a few seconds), and far enough
// below HOLD_SECONDS that a restart which had waited out the sleep could not
// possibly land inside it.
const MAX_RESTART_AFTER_CHECKPOINT_MS = 60000;

type StepEntry = { step: string; status?: string; attempts?: number };

type RestartInflightData = {
  hold_seconds: number;
  inflight_run_id: string;
  status_before_restart: string;
  step_log: StepEntry[];
  inflight_run_read: { status: string; message?: string; stdout?: string; run_id?: string };
  inflight_run_read_attempts: number;
  inflight_run_read_elapsed_ms: number;
  recovery_attempt: { status: string; run_id: string };
  recovery_result: { status: string; stdout?: string };
  checkpoint_at: number;
  restart_completed_after_checkpoint_ms: number;
  environment_after: Record<string, boolean>;
  console_truth: Record<string, boolean>;
  console_probe_stdout: string | null;
  environment_agrees_with_console: boolean;
};

function readData(file: string): RestartInflightData | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as RestartInflightData : null;
}

function readCheckpoint(file: string): { run_id: string; status_before_restart: string } | null {
  if (!fs.existsSync(file))
    return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
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

test.describe('RAI Assistant restart during an in-flight Console run (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('reports the interrupted run as session_restarted and leaves the Console slot usable in the fresh session', async ({ rstudioPage: page }) => {
    test.setTimeout(300000);

    raiTest = await setupScriptedRaiTest(
      'restart-during-inflight-run',
      'fake-claude-provider-restart-during-inflight-run.mjs',
      {},
      undefined,
      true,
    );

    await openScenarioProject(page, raiTest);
    const consoleActions = new ConsolePaneActions(page);
    await consoleActions.clearConsole();

    await openAssistant(page);
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);

    // --- Wait until a run is genuinely in flight. The fixture writes this
    // only after confirming the run is still non-terminal, so restarting now
    // lands inside it rather than after it. ---------------------------------
    const checkpointFile = path.join(raiTest.stateDir, 'inflight-checkpoint');
    await expect.poll(() => readCheckpoint(checkpointFile), { timeout: 120000, intervals: [500] }).not.toBeNull();
    const checkpoint = readCheckpoint(checkpointFile)!;
    expect(['pending', 'running']).toContain(checkpoint.status_before_restart);

    // --- Restart R underneath the running code. Polling here is only about
    // confirming the restart actually happened -- the session goes not-ready,
    // comes back ready, and the Assistant reattaches. ------------------------
    const restartBegan = page.waitForFunction(() => (window as any).rstudio?.ready === false, null, { timeout: 60000 });
    await executeCommand(page, 'restartR');
    await restartBegan;
    await page.waitForFunction(() => (window as any).rstudio?.ready === true, null, { timeout: 90000 });
    await expect.poll(() => getChatState(page), { timeout: 90000, intervals: [1000] }).toBe('ready');
    const restartCompletedAt = Date.now();

    fs.writeFileSync(
      path.join(raiTest.stateDir, 'post-restart'),
      JSON.stringify({ restart_completed_at: restartCompletedAt }),
    );

    const dataFile = path.join(raiTest.stateDir, 'restart-inflight-data.json');
    await expect.poll(() => readData(dataFile), { timeout: 180000, intervals: [1000] }).not.toBeNull();
    const data = readData(dataFile)!;
    // The sandbox is removed by globalTeardown, so copy the MCP transcript
    // this asserts on into the run's artifacts before it disappears.
    const evidence = test.info().outputPath('restart-inflight-data.json');
    fs.copyFileSync(dataFile, evidence);
    await test.info().attach('restart-inflight-data.json', { path: evidence, contentType: 'application/json' });

    // --- The race genuinely happened: the run was non-terminal at the
    // checkpoint, and the restart completed far inside the hold window, so the
    // code was still executing when the session was replaced. ---------------
    expect(data.hold_seconds).toBe(HOLD_SECONDS);
    expect(['pending', 'running']).toContain(data.status_before_restart);
    expect(data.restart_completed_after_checkpoint_ms).toBeLessThan(MAX_RESTART_AFTER_CHECKPOINT_MS);
    expect(data.restart_completed_after_checkpoint_ms).toBeLessThan(data.hold_seconds * 1000);

    // --- Hazard 1: the in-flight run_id reports the restart rather than a
    // result, a hang, or an invented terminal status. -----------------------
    expect(data.inflight_run_read.status).toBe('session_restarted');
    expect(data.inflight_run_read.status).not.toBe('ok');
    expect(data.inflight_run_read.stdout).toBeUndefined();
    expect(data.inflight_run_read.message).toMatch(/R restarted/i);
    // It answered promptly -- the dead run did not make the reader wait out
    // the remainder of the interrupted sleep.
    expect(data.inflight_run_read_elapsed_ms).toBeLessThan(data.hold_seconds * 1000);

    // --- Hazard 2: the capture slot survived the kill unheld, so a fresh
    // run queued and completed normally in the new session. -----------------
    expect(data.recovery_attempt.status).toBe('queued');
    expect(data.recovery_attempt.run_id).not.toBe(data.inflight_run_id);
    expect(data.recovery_result.status).toBe('ok');
    expect(data.recovery_result.stdout).toContain('RAI_INFLIGHT_RECOVERY_DONE');

    // --- The interrupted run's binding never came into existence, and the
    // recovery run's did. ---------------------------------------------------
    expect(data.console_truth).toEqual({ rai_inflight_marker: false, rai_inflight_recovery: true });
    expect(data.environment_after).toEqual(data.console_truth);
    expect(data.environment_agrees_with_console).toBe(true);
    expect(data.console_probe_stdout).toContain('RAI_INFLIGHT_PROBE FALSE TRUE');

    // --- Ordering: every post-restart read happened after the checkpoint. --
    expect(data.step_log.map((entry) => entry.step)).toEqual([
      'inflight-submit', 'status-before-restart', 'inflight-run-read',
      'recovery-submit', 'recovery-result', 'console-probe',
    ]);

    // --- Independently confirm the recovered session in the live Environment
    // pane, not only through the MCP transcript. ----------------------------
    const envPane = new EnvironmentPane(page);
    await executeCommand(page, 'activateEnvironment');
    await expect.poll(
      () => envPane.hasVariable('rai_inflight_recovery', '7'),
      { timeout: TIMEOUTS.environmentUpdate, intervals: [TIMEOUTS.pollInterval] },
    ).toBe(true);
  });
});

