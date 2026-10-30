import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import type { Page } from 'playwright';
import { documentOpen, executeCommand } from '@utils/commands';
import { EnvironmentPane } from '@pages/environment_pane.page';
import { AceEditor } from '@pages/ace_editor.page';
import { TIMEOUTS } from '@utils/constants';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

// Regression guard for the audit write-back path on an .Rmd document. The
// multi-chunk-audit fixture covers the run -> fail -> fix -> retest loop, but
// only against a plain .R file, where there are no fences, no prose, and
// edit_document's context anchors are optional. .Rmd is the format an "audit
// my notebook chunk by chunk" request actually arrives in, and it is where an
// edit can go wrong in ways a .R file cannot -- swallowing a fence marker, or
// matching prose outside the chunk.
//
// Constants are duplicated (not imported) from
// fixtures/fake-claude-provider-rmd-chunk-writeback.mjs -- keep both in sync
// if the scripted chunks ever change.
const FENCE = '```';
const CHUNK_SETUP = 'rai_rmd_base <- 5L';
const CHUNK_COMPUTE_ORIGINAL = 'rai_rmd_total <- rai_rmd_bse * 4L';
const CHUNK_COMPUTE_FIXED = 'rai_rmd_total <- rai_rmd_base * 4L';
const CHUNK_REPORT = 'print(rai_rmd_total)';

function rmdSource(computeBody: string): string {
  return [
    '---',
    'title: "RAI Rmd audit"',
    '---',
    '',
    'Prose above the setup chunk. The audit edit must not touch this line.',
    '',
    `${FENCE}{r setup}`,
    CHUNK_SETUP,
    FENCE,
    '',
    'Prose between the chunks. The audit edit must not touch this line either.',
    '',
    `${FENCE}{r compute}`,
    computeBody,
    FENCE,
    '',
    'Prose below the compute chunk, ahead of the report chunk.',
    '',
    `${FENCE}{r report}`,
    CHUNK_REPORT,
    FENCE,
    '',
  ].join('\n');
}

const RMD_ORIGINAL = rmdSource(CHUNK_COMPUTE_ORIGINAL);
const RMD_FIXED = rmdSource(CHUNK_COMPUTE_FIXED);

type StepEntry = { chunk?: string; step?: string; status: string; stdout?: string | null };

type RmdWritebackData = {
  step_log: StepEntry[];
  document_id: string;
  document_type: string | null;
  original_contents: string;
  fences_before: number;
  setup_result: { status: string };
  compute_first_result: { status: string; stderr?: string };
  unanchored_edit_error: string | null;
  contents_after_refusal: string;
  applied_contents: string;
  fences_after: number;
  compute_retest_result: { status: string };
  report_result: { status: string; stdout?: string };
  environment_detail: { objects: Array<{ name: string; found: boolean }> };
};

function readData(file: string): RmdWritebackData | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as RmdWritebackData : null;
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

test.describe('RAI Assistant .Rmd chunk write-back (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('fixes a buggy .Rmd chunk strictly inside its fence, leaving every fence marker and prose line untouched', async ({ rstudioPage: page }) => {
    test.setTimeout(180000);

    raiTest = await setupScriptedRaiTest(
      'rmd-chunk-writeback',
      'fake-claude-provider-rmd-chunk-writeback.mjs',
      { 'analysis.Rmd': RMD_ORIGINAL },
      undefined,
      true,
    );

    await openScenarioProject(page, raiTest);

    const analysisPath = path.join(path.dirname(raiTest.projectFile), 'analysis.Rmd');
    await documentOpen(page, analysisPath);
    const editor = new AceEditor(page, '');
    await expect.poll(() => editor.getValue(), { timeout: 15000 }).toBe(RMD_ORIGINAL);

    await openAssistant(page);

    // Explicit Full Auto: no card is expected; the durable transcript below
    // still proves each native run and editor result.

    const dataFile = path.join(raiTest.stateDir, 'rmd-writeback-data.json');
    await expect.poll(() => readData(dataFile), { timeout: 150000, intervals: [1000] }).not.toBeNull();
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);
    const data = readData(dataFile)!;
    // The sandbox is removed by globalTeardown, so copy the MCP transcript
    // this asserts on into the run's artifacts before it disappears.
    const evidence = test.info().outputPath('rmd-writeback-data.json');
    fs.copyFileSync(dataFile, evidence);
    await test.info().attach('rmd-writeback-data.json', { path: evidence, contentType: 'application/json' });

    // --- The document really is an .Rmd, so the .Rmd-specific anchor rules
    // below are the ones under test. ------------------------------------------
    expect(data.document_type).toBe('r_markdown');
    expect(data.original_contents).toBe(RMD_ORIGINAL);

    // --- Setup ran clean; the compute chunk genuinely failed on its typo. ----
    expect(data.setup_result.status).toBe('ok');
    expect(data.compute_first_result.status).toBe('error');
    expect(data.compute_first_result.stderr).toContain('rai_rmd_bse');

    // --- .Rmd boundary: the same edit without fence anchors is refused, and
    // the refusal leaves the buffer byte-identical. ---------------------------
    expect(data.unanchored_edit_error).toMatch(/context_before/);
    expect(data.contents_after_refusal).toBe(RMD_ORIGINAL);

    // --- The anchored edit changed the chunk body and NOTHING else: whole
    // document byte-equal to the expected fixed text, fence count unchanged,
    // every fence marker and prose line still present verbatim. --------------
    expect(data.applied_contents).toBe(RMD_FIXED);
    expect(data.fences_after).toBe(data.fences_before);
    expect(data.fences_before).toBe(6);
    expect(data.applied_contents).toContain(`${FENCE}{r compute}\n${CHUNK_COMPUTE_FIXED}\n${FENCE}`);
    expect(data.applied_contents).toContain('Prose above the setup chunk. The audit edit must not touch this line.');
    expect(data.applied_contents).toContain('Prose between the chunks. The audit edit must not touch this line either.');
    expect(data.applied_contents).toContain('Prose below the compute chunk, ahead of the report chunk.');
    expect(data.applied_contents).toContain('title: "RAI Rmd audit"');
    expect(data.applied_contents).not.toContain(CHUNK_COMPUTE_ORIGINAL);
    await expect.poll(() => editor.getValue(), { timeout: 15000 }).toBe(RMD_FIXED);

    // --- The fix was retested in the real Console and the dependent report
    // chunk then produced the value that only a genuine fix can yield. -------
    expect(data.compute_retest_result.status).toBe('ok');
    expect(data.report_result.status).toBe('ok');
    expect(data.report_result.stdout).toContain('20');
    expect(data.environment_detail.objects.find((object) => object.name === 'rai_rmd_total')?.found).toBe(true);

    // --- Step ordering: fail, refused unanchored edit, anchored edit, retest,
    // dependent chunk -- strictly in that order. ------------------------------
    expect(data.step_log.map((entry) => entry.chunk ?? entry.step)).toEqual([
      'setup', 'compute-original', 'edit_document-unanchored', 'edit_document', 'compute-fixed', 'report',
    ]);

    // --- Independently confirm the value in the live Environment pane. ------
    const envPane = new EnvironmentPane(page);
    await executeCommand(page, 'activateEnvironment');
    await expect.poll(
      () => envPane.hasVariable('rai_rmd_total', '20'),
      { timeout: TIMEOUTS.environmentUpdate, intervals: [TIMEOUTS.pollInterval] },
    ).toBe(true);

    // RAI saving is always on, so the anchored replacement is on disk as well as in the open buffer.
    expect(fs.readFileSync(analysisPath, 'utf8')).toBe(RMD_FIXED);
  });
});

