import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import type { Page } from 'playwright';
import { executeCommand, getChatState } from '@utils/commands';
import { EnvironmentPane } from '@pages/environment_pane.page';
import { TIMEOUTS } from '@utils/constants';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

// Regression guard for QUEUE DEPTH on the single-in-flight Console run
// contract. rai-concurrent-run-guard-scripted.test.ts covers the one-at-a-time
// probes -- one different proposal mid-run is refused, the same proposal
// mid-run dedupes onto its run -- and neither answers the question here: what
// happens to a BURST of distinct proposals fired together, none of them a
// retry of anything.
//
// That is the shape an eager audit produces. The assistant reads chunk 1's
// submission, judges chunks 2, 3 and 4 independent, and fires all three
// without waiting. If the native side held even a one-slot queue, one of them
// would execute later, unattended, with nobody polling it -- side effects
// landing in .GlobalEnv from a run no caller is watching.
//
// OBSERVED BEHAVIOR, asserted here rather than assumed (native source is
// SessionRaiAssistant.cpp handleConsoleRunRequest; this test was written
// against what the packaged app actually returned):
//
//   * Queue depth is ZERO. All three concurrent distinct proposals are
//     refused with status "busy" / "a console run is already in progress" and
//     no run_id. None is queued, deferred, or retried later: after the holding
//     run settles, not one of their bindings exists until the caller
//     explicitly resubmits.
//   * The refusals come from the RESERVATION path, not the digest-dedupe
//     path, and the wire tells them apart -- the dedupe branch builds a
//     json::Object carrying session_id, while the reservation failure writes a
//     hardcoded body with none. So these were refused as genuinely new
//     proposals, not mistaken for retries of each other.
//   * The refusals are decided in C++ before re-entering R, so all three come
//     back promptly instead of blocking behind the running code.
//   * Nothing is poisoned: once the slot frees, all three run normally, in
//     resubmission order.

type Attempt = {
  label: string;
  elapsed_ms: number;
  status: string | null;
  run_id: string | null;
  message: string | null;
  has_session_id: boolean;
};

type ConcurrentDistinctData = {
  hold_seconds: number;
  first_run_id: string;
  first_submit: Attempt;
  status_before_burst: string;
  burst_attempts: Attempt[];
  burst_span_ms: number;
  status_after_burst: string;
  environment_during_hold: Record<string, boolean>;
  first_result: { status: string; stdout?: string };
  environment_after_settle: Record<string, boolean>;
  environment_after_grace: Record<string, boolean>;
  retries: Array<{ name: string; attempt: Attempt; status: string; stdout: string | null }>;
  final_environment: Record<string, boolean>;
  poll_log: Array<{ run_id: string; status: string }>;
};

const BURST_NAMES = ['rai_burst_alpha', 'rai_burst_bravo', 'rai_burst_charlie'];
const ALL_NAMES = ['rai_burst_first', ...BURST_NAMES];

function readData(file: string): ConcurrentDistinctData | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as ConcurrentDistinctData : null;
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

test.describe('RAI Assistant concurrent distinct Console runs (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('refuses a burst of three distinct proposals with zero queue depth, then runs all three once the slot frees', async ({ rstudioPage: page }) => {
    test.setTimeout(240000);

    raiTest = await setupScriptedRaiTest(
      'concurrent-run-distinct-guard',
      'fake-claude-provider-concurrent-run-distinct-guard.mjs',
      {},
      undefined,
      true,
    );

    await openScenarioProject(page, raiTest);
    await openAssistant(page);

    const approvalCard = page.locator('.rai-approval-card');
    await expect(approvalCard).toHaveCount(0);

    const dataFile = path.join(raiTest.stateDir, 'concurrent-distinct-data.json');
    await expect.poll(() => readData(dataFile), { timeout: 210000, intervals: [1000] }).not.toBeNull();
    const data = readData(dataFile)!;
    // The sandbox is removed by globalTeardown, so copy the MCP transcript
    // this asserts on into the run's artifacts before it disappears.
    const evidence = test.info().outputPath('concurrent-distinct-data.json');
    fs.copyFileSync(dataFile, evidence);
    await test.info().attach('concurrent-distinct-data.json', { path: evidence, contentType: 'application/json' });

    // --- The burst was genuinely concurrent: the holding run was non-terminal
    // both before it and after all three answers came back. ------------------
    expect(['pending', 'running']).toContain(data.status_before_burst);
    expect(['pending', 'running']).toContain(data.status_after_burst);

    // --- All three distinct proposals were refused outright. ---------------
    expect(data.burst_attempts).toHaveLength(3);
    expect(data.burst_attempts.map((attempt) => attempt.label)).toEqual(BURST_NAMES);
    for (const attempt of data.burst_attempts) {
      expect(attempt.status).toBe('busy');
      expect(attempt.run_id).toBeNull();
      expect(attempt.message).toBe('a console run is already in progress');
      // The reservation-failure body carries no session_id; the digest-dedupe
      // body does. This is what proves each was refused as a NEW proposal
      // rather than collapsed onto another burst member as a retry.
      expect(attempt.has_session_id).toBe(false);
      // Decided natively without waiting on the running code.
      expect(attempt.elapsed_ms).toBeLessThan(data.hold_seconds * 1000);
    }

    // --- The whole burst was answered well inside the hold, so all three
    // really were in flight together rather than trickling out serially. ----
    expect(data.burst_span_ms).toBeLessThan(data.hold_seconds * 1000);

    // --- Not one binding existed while the holding run ran. ----------------
    expect(data.environment_during_hold).toEqual({
      rai_burst_first: false, rai_burst_alpha: false, rai_burst_bravo: false, rai_burst_charlie: false,
    });

    // --- The holding run completed normally despite the refused traffic. ---
    expect(data.first_result.status).toBe('ok');
    expect(data.first_result.stdout).toContain('RAI_BURST_FIRST_DONE');

    // --- QUEUE DEPTH IS ZERO. Immediately after the slot freed, and again
    // after a grace window that would let any deferred run surface, only the
    // holding run's binding exists. Nothing was remembered and replayed. ----
    const onlyFirst = {
      rai_burst_first: true, rai_burst_alpha: false, rai_burst_bravo: false, rai_burst_charlie: false,
    };
    expect(data.environment_after_settle).toEqual(onlyFirst);
    expect(data.environment_after_grace).toEqual(onlyFirst);

    // --- A busy refusal is not sticky: all three ran on explicit resubmit,
    // each with its own run_id, in submission order. ------------------------
    expect(data.retries.map((entry) => entry.name)).toEqual(BURST_NAMES);
    const retryRunIds = data.retries.map((entry) => entry.attempt.run_id);
    expect(new Set(retryRunIds).size).toBe(3);
    expect(retryRunIds).not.toContain(data.first_run_id);
    for (const entry of data.retries) {
      expect(entry.attempt.status).toBe('queued');
      expect(entry.status).toBe('ok');
    }
    expect(data.retries[0].stdout).toContain('RAI_BURST_ALPHA_DONE');
    expect(data.retries[1].stdout).toContain('RAI_BURST_BRAVO_DONE');
    expect(data.retries[2].stdout).toContain('RAI_BURST_CHARLIE_DONE');
    expect(data.final_environment).toEqual(Object.fromEntries(ALL_NAMES.map((name) => [name, true])));

    // --- Independently confirm the last binding landed, in the real
    // Environment pane rather than only via the MCP transcript. -------------
    const envPane = new EnvironmentPane(page);
    await executeCommand(page, 'activateEnvironment');
    await expect.poll(
      () => envPane.hasVariable('rai_burst_charlie', '4'),
      { timeout: TIMEOUTS.environmentUpdate, intervals: [TIMEOUTS.pollInterval] },
    ).toBe(true);
  });
});
