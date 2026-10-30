import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import type { Page } from 'playwright';
import { executeCommand, getChatState } from '@utils/commands';
import { EnvironmentPane } from '@pages/environment_pane.page';
import { TIMEOUTS } from '@utils/constants';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

// Regression guard for the single-in-flight Console run contract. Every other
// scripted fixture submits one run at a time and waits, so none of them
// exercises a second, DIFFERENT proposal arriving while a Console run still
// holds the capture slot -- the exact shape of an audit loop that fires the
// next chunk before reading the previous one's result.
//
// OBSERVED BEHAVIOR, asserted here rather than assumed (the native source is
// SessionRaiAssistant.cpp handleConsoleRunRequest, and this test was written
// against what the packaged app actually returned):
//
//   * A different proposal submitted mid-run is REJECTED with
//     status "busy" / "a console run is already in progress" and NO run_id.
//     It is not queued behind the running one, and it is not serialized --
//     the caller is told to come back, and nothing is remembered.
//   * The same proposal resubmitted mid-run is DEDUPED onto the run already
//     in flight: status "queued" with the identical run_id, so a client
//     retrying its own proposal cannot spawn a second live run.
//   * A busy rejection is not sticky: once the first run settles, the
//     rejected proposal submits and executes normally.
//
// The invariant underneath all three is that the second chunk's side effects
// never appear while the first chunk is still running.

type Attempt = { elapsed_ms: number; status: string | null; run_id: string | null; message: string | null };

type ConcurrentGuardData = {
  hold_seconds: number;
  first_run_id: string;
  first_submit: Attempt;
  status_before_concurrent: string;
  concurrent_attempt: Attempt;
  duplicate_attempt: Attempt;
  status_after_probes: string;
  environment_during_hold: Record<string, boolean>;
  first_result: { status: string; stdout?: string };
  retry_attempt: Attempt;
  second_result: { status: string; stdout?: string };
  final_environment: Record<string, boolean>;
  poll_log: Array<{ run_id: string; status: string }>;
};

function readData(file: string): ConcurrentGuardData | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as ConcurrentGuardData : null;
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

test.describe('RAI Assistant concurrent Console run guard (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('rejects a second proposal while a run holds the Console, dedupes a retry of the same one, and runs it after the slot frees', async ({ rstudioPage: page }) => {
    test.setTimeout(180000);

    raiTest = await setupScriptedRaiTest(
      'concurrent-run-guard',
      'fake-claude-provider-concurrent-run-guard.mjs',
      {},
      undefined,
      true,
    );

    await openScenarioProject(page, raiTest);
    await openAssistant(page);

    const approvalCard = page.locator('.rai-approval-card');
    await expect(approvalCard).toHaveCount(0);

    const dataFile = path.join(raiTest.stateDir, 'concurrent-guard-data.json');
    await expect.poll(() => readData(dataFile), { timeout: 150000, intervals: [1000] }).not.toBeNull();
    const data = readData(dataFile)!;
    // The sandbox is removed by globalTeardown, so copy the MCP transcript
    // this asserts on into the run's artifacts before it disappears.
    const evidence = test.info().outputPath('concurrent-guard-data.json');
    fs.copyFileSync(dataFile, evidence);
    await test.info().attach('concurrent-guard-data.json', { path: evidence, contentType: 'application/json' });

    // --- The probe was genuinely concurrent: run 1 was still non-terminal
    // both before and after the second submission. ---------------------------
    expect(['pending', 'running']).toContain(data.status_before_concurrent);
    expect(['pending', 'running']).toContain(data.status_after_probes);

    // --- A DIFFERENT proposal mid-run is refused outright: "busy", no
    // run_id, and the caller is told why. ------------------------------------
    expect(data.concurrent_attempt.status).toBe('busy');
    expect(data.concurrent_attempt.run_id).toBeNull();
    expect(data.concurrent_attempt.message).toBe('a console run is already in progress');

    // --- The refusal is decided natively without waiting on the running
    // code, so the caller is not blocked for the whole hold. -----------------
    expect(data.concurrent_attempt.elapsed_ms).toBeLessThan(data.hold_seconds * 1000);

    // --- The SAME proposal mid-run is deduped onto its existing run rather
    // than refused or duplicated. ---------------------------------------------
    expect(data.duplicate_attempt.status).toBe('queued');
    expect(data.duplicate_attempt.run_id).toBe(data.first_run_id);

    // --- The invariant: run 2's binding did not exist while run 1 was still
    // running, so nothing was interleaved behind the guard. -------------------
    expect(data.environment_during_hold).toEqual({ rai_guard_first: false, rai_guard_second: false });

    // --- Run 1 completed normally despite the rejected traffic during it. ---
    expect(data.first_result.status).toBe('ok');
    expect(data.first_result.stdout).toContain('RAI_GUARD_FIRST_DONE');

    // --- A busy rejection is not sticky: once the slot freed, the same
    // proposal queued and ran. -------------------------------------------------
    expect(data.retry_attempt.status).toBe('queued');
    expect(data.retry_attempt.run_id).not.toBeNull();
    expect(data.retry_attempt.run_id).not.toBe(data.first_run_id);
    expect(data.second_result.status).toBe('ok');
    expect(data.second_result.stdout).toContain('RAI_GUARD_SECOND_DONE');
    expect(data.final_environment).toEqual({ rai_guard_first: true, rai_guard_second: true });

    // --- Independently confirm both bindings landed, in the real
    // Environment pane rather than only via the MCP transcript. --------------
    const envPane = new EnvironmentPane(page);
    await executeCommand(page, 'activateEnvironment');
    await expect.poll(
      () => envPane.hasVariable('rai_guard_second', '2'),
      { timeout: TIMEOUTS.environmentUpdate, intervals: [TIMEOUTS.pollInterval] },
    ).toBe(true);
  });
});
