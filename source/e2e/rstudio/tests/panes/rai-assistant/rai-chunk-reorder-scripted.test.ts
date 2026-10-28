import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import type { Page } from 'playwright';
import { documentOpen, executeCommand } from '@utils/commands';
import { EnvironmentPane } from '@pages/environment_pane.page';
import { AceEditor } from '@pages/ace_editor.page';
import { TIMEOUTS } from '@utils/constants';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

// Regression guard for the dependency-REORDER half of the Console audit
// contract: a chunk that needs an object provided by a chunk placed AFTER it
// must be fixed by physically moving the source chunks, not by handing the
// user a manual run order. Every other audit fixture here fixes a chunk in
// place, so none of them could catch a build that leaves the file itself
// still broken while reporting the audit as resolved.
//
// The mid-run environment reset is what makes this a real test: every binding
// the as-written pass created is removed before the second top-down pass, so
// that pass can only succeed because the FILE now orders producer before
// consumer.
//
// Constants are duplicated (not imported) from
// fixtures/fake-claude-provider-chunk-reorder.mjs -- keep both in sync if the
// scripted chunks ever change.
const CHUNK_CONSUMER = '{ rai_reorder_scaled <- rai_reorder_base * 3L; print(rai_reorder_scaled) }';
const CHUNK_PRODUCER = 'rai_reorder_base <- 7L';
const SOURCE_ORIGINAL = `${CHUNK_CONSUMER}\n\n${CHUNK_PRODUCER}\n`;
const SOURCE_REORDERED = `${CHUNK_PRODUCER}\n\n${CHUNK_CONSUMER}\n`;

type PassEntry = { index: number; code: string; status: string; stdout?: string | null; stderr?: string | null };

type ChunkReorderData = {
  step_log: Array<{ pass?: string; step?: string; index?: number; status: string }>;
  document_id: string;
  original_contents: string;
  first_pass: PassEntry[];
  edit_status: string | null;
  reordered_contents: string;
  reset_result: { status: string };
  cleared_environment: Record<string, boolean>;
  second_pass: PassEntry[];
  final_environment: Record<string, boolean>;
};

function readData(file: string): ChunkReorderData | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as ChunkReorderData : null;
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

test.describe('RAI Assistant chunk reorder audit (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('reorders the real source so the producer precedes its consumer, then proves it with a clean top-down rerun', async ({ rstudioPage: page }) => {
    test.setTimeout(180000);

    raiTest = await setupScriptedRaiTest(
      'chunk-reorder',
      'fake-claude-provider-chunk-reorder.mjs',
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

    const dataFile = path.join(raiTest.stateDir, 'chunk-reorder-data.json');
    await expect.poll(() => readData(dataFile), { timeout: 150000, intervals: [1000] }).not.toBeNull();
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);
    const data = readData(dataFile)!;
    // The sandbox is removed by globalTeardown, so copy the MCP transcript
    // this asserts on into the run's artifacts before it disappears.
    const evidence = test.info().outputPath('chunk-reorder-data.json');
    fs.copyFileSync(dataFile, evidence);
    await test.info().attach('chunk-reorder-data.json', { path: evidence, contentType: 'application/json' });

    // --- The as-written order genuinely fails: the consumer runs first and
    // errors on the object its producer has not created yet. ------------------
    expect(data.original_contents).toBe(SOURCE_ORIGINAL);
    expect(data.first_pass.map((entry) => entry.code)).toEqual([CHUNK_CONSUMER, CHUNK_PRODUCER]);
    expect(data.first_pass[0].status).toBe('error');
    expect(data.first_pass[0].stderr).toContain('rai_reorder_base');
    expect(data.first_pass[1].status).toBe('ok');

    // --- The fix physically MOVED the chunks in the real source buffer,
    // rather than leaving the file broken and rerunning out of order. --------
    expect(data.reordered_contents).toBe(SOURCE_REORDERED);
    await expect.poll(() => editor.getValue(), { timeout: 15000 }).toBe(SOURCE_REORDERED);

    // --- The reset really emptied the slate, so the rerun below cannot be
    // riding on bindings the first pass happened to leave behind. -------------
    expect(data.reset_result.status).toBe('ok');
    expect(data.cleared_environment).toEqual({ rai_reorder_base: false, rai_reorder_scaled: false });

    // --- Top-down again, driven by the FILE's own order: producer first now,
    // both blocks clean, and the dependent value is correct. ------------------
    expect(data.second_pass.map((entry) => entry.code)).toEqual([CHUNK_PRODUCER, CHUNK_CONSUMER]);
    expect(data.second_pass.map((entry) => entry.status)).toEqual(['ok', 'ok']);
    expect(data.second_pass[1].stdout).toContain('21');
    expect(data.final_environment).toEqual({ rai_reorder_base: true, rai_reorder_scaled: true });

    // --- Step ordering: the reorder happened after the failure was observed
    // and before the clean rerun, nothing skipped. ---------------------------
    expect(data.step_log.map((entry) => entry.step ?? `${entry.pass}:${entry.index}`)).toEqual([
      'as-written:0', 'as-written:1', 'edit_document', 'reset', 'reordered:0', 'reordered:1',
    ]);

    // --- Independently confirm the final value in the live Environment pane,
    // not just via the MCP transcript. ----------------------------------------
    const envPane = new EnvironmentPane(page);
    await executeCommand(page, 'activateEnvironment');
    await expect.poll(
      () => envPane.hasVariable('rai_reorder_scaled', '21'),
      { timeout: TIMEOUTS.environmentUpdate, intervals: [TIMEOUTS.pollInterval] },
    ).toBe(true);

    // RAI saving is always on, so the reordered buffer is saved.
    expect(fs.readFileSync(analysisPath, 'utf8')).toBe(SOURCE_REORDERED);
  });
});
