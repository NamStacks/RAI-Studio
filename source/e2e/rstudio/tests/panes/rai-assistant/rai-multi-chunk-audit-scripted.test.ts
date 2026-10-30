import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import type { Page } from 'playwright';
import { documentOpen, executeCommand } from '@utils/commands';
import { EnvironmentPane } from '@pages/environment_pane.page';
import { AceEditor } from '@pages/ace_editor.page';
import { TIMEOUTS } from '@utils/constants';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

// Regression guard for the full multi-chunk audit loop: run a chunk, detect
// a genuine failure, derive a fix, write it back to the SOURCE FILE, re-run
// the corrected chunk to confirm it actually passes now, and only then
// proceed to a chunk that depends on the fix. No prior fixture exercised
// this end-to-end -- each one either ran a single isolated chunk or applied
// one edit with no downstream dependent chunk to prove the fix was real.
//
// Constants are duplicated (not imported) from
// fixtures/fake-claude-provider-multi-chunk-audit.mjs -- keep both in sync
// if the scripted chunks ever change.
const CHUNK_2_ORIGINAL = 'rai_audit_scaled <- bas * 3L';
const CHUNK_2_FIXED = 'rai_audit_scaled <- base * 3L';
const CHUNK_3 = '{ rai_audit_total <- rai_audit_scaled + base; print(rai_audit_total) }';
const SOURCE_ORIGINAL = `base <- 10L\n\n${CHUNK_2_ORIGINAL}\n\n${CHUNK_3}\n`;
const SOURCE_FIXED = `base <- 10L\n\n${CHUNK_2_FIXED}\n\n${CHUNK_3}\n`;

type StepEntry = { chunk?: number | string; step?: string; status: string; error?: string | null; stdout?: string | null };

type MultiChunkAuditData = {
  step_log: StepEntry[];
  chunk1_result: { status: string };
  chunk2_first_result: { status: string };
  edit_document_id: string;
  applied_source_contents: string;
  chunk2_retest_result: { status: string };
  chunk3_result: { status: string; stdout?: string };
};

function readData(file: string): MultiChunkAuditData | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as MultiChunkAuditData : null;
}

async function openAssistant(page: Page): Promise<void> {
  // Full Auto can finish and reconnect before the transient iframe is sampled.
  // The run below requires its durable provider transcript and native outcomes.
  await executeCommand(page, 'activateChat');
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

test.describe('RAI Assistant multi-chunk audit loop (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('runs chunk by chunk, fixes a genuine failure, writes it to source, retests, then proceeds to the dependent chunk', async ({ rstudioPage: page }) => {
    test.setTimeout(180000);

    raiTest = await setupScriptedRaiTest(
      'multi-chunk-audit',
      'fake-claude-provider-multi-chunk-audit.mjs',
      { 'analysis.R': SOURCE_ORIGINAL },
      undefined,
      true,
    );

    await openScenarioProject(page, raiTest);

    const analysisPath = path.join(path.dirname(raiTest.projectFile), 'analysis.R');
    await documentOpen(page, analysisPath);
    const editor = new AceEditor(page, '');
    await expect.poll(() => editor.getValue(), { timeout: 15000 }).toBe(SOURCE_ORIGINAL);

    await openAssistant(page);

    // Explicit Full Auto: no card is expected; the durable transcript below
    // still proves each native run and editor result.

    const dataFile = path.join(raiTest.stateDir, 'multi-chunk-audit-data.json');
    await expect.poll(() => readData(dataFile), { timeout: 150000, intervals: [1000] }).not.toBeNull();
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);
    const data = readData(dataFile)!;

    // --- Chunk 1 ran clean. ----------------------------------------------------
    expect(data.chunk1_result.status).toBe('ok');

    // --- Chunk 2 genuinely failed on the ORIGINAL buggy code -- this is not a
    // fixture that already knew the fix; it had to hit a real error first. -----
    expect(data.chunk2_first_result.status).toBe('error');

    // --- The fix was written back to the actual SOURCE FILE (the open IDE
    // buffer), not just reported in chat. ----------------------------------------
    expect(data.applied_source_contents).toBe(SOURCE_FIXED);
    expect(data.applied_source_contents).not.toContain(CHUNK_2_ORIGINAL);
    expect(data.applied_source_contents).toContain(CHUNK_2_FIXED);
    await expect.poll(() => editor.getValue(), { timeout: 15000 }).toBe(SOURCE_FIXED);

    // --- The fix was RETESTED in the real Console and genuinely passed, not
    // assumed correct from the edit alone. ---------------------------------------
    expect(data.chunk2_retest_result.status).toBe('ok');

    // --- Chunk 3, which depends on chunk 2's corrected value, only ran (and
    // only produced the right answer) after the fix-and-retest cycle
    // completed -- proving the loop gates forward progress on real success. ----
    expect(data.chunk3_result.status).toBe('ok');
    expect(data.chunk3_result.stdout).toContain('40');

    // --- Step ordering: chunk 1 -> chunk 2 (fail) -> edit -> chunk 2 (fixed,
    // ok) -> chunk 3, strictly in that order, nothing skipped. -------------------
    const order = data.step_log.map((entry) => entry.chunk ?? entry.step);
    expect(order).toEqual([1, '2-original', 'edit_document', '2-fixed', 3]);

    // --- Independently confirm the fixed environment state in the live
    // Environment pane, not just via the MCP transcript. -------------------------
    const envPane = new EnvironmentPane(page);
    await executeCommand(page, 'activateEnvironment');
    await expect.poll(
      () => envPane.hasVariable('rai_audit_total', '40'),
      { timeout: TIMEOUTS.environmentUpdate, intervals: [TIMEOUTS.pollInterval] },
    ).toBe(true);

    // RAI saving is always on, so the same exact replacement is on disk as well as in the open buffer.
    expect(fs.readFileSync(analysisPath, 'utf8')).toBe(SOURCE_FIXED);
  });
});

