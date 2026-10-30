import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import type { Page } from 'playwright';
import { documentOpen, executeCommand } from '@utils/commands';
import { EnvironmentPane } from '@pages/environment_pane.page';
import { AceEditor } from '@pages/ace_editor.page';
import { TIMEOUTS } from '@utils/constants';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

// Regression guard for the .Rmd structures a real notebook actually contains.
// rai-rmd-chunk-writeback-scripted.test.ts covers the simplest possible
// document -- YAML, prose, three uniquely-labeled chunks -- where every anchor
// is unambiguous and every line is inert. A real notebook is not like that,
// and each structure below is a distinct way an audit edit can corrupt one:
//
//   (a) An INLINE r expression in prose (`r rai_nb_total`): live code outside
//       any fence, referencing what the chunks compute. A fix that did not
//       really fix shows up as the wrong rendered value here.
//   (b) A chunk with explicit OPTIONS ({r setup-labeled, echo=FALSE,
//       warning=FALSE}). The options sit on the fence header line, which is
//       exactly what an over-greedy replacement swallows; losing echo=FALSE
//       silently changes the rendered document.
//   (c) TWO ANONYMOUS chunks ({r}, auto-numbered by R Markdown), so the
//       identical header text appears twice with no label to anchor on.
//   (d) YAML FRONTMATTER, which must survive untouched.
//
// OBSERVED BEHAVIOR, asserted here rather than assumed (native source is
// raiValidateAnchoredEdit in SessionRaiAssistant.cpp; this test was written
// against what the packaged app actually returned):
//
//   * Uniqueness is judged on expected_text ALONE and BEFORE context is
//     considered, so the anonymous fence header can never anchor an edit --
//     it occurs twice and is refused with "expected_text must occur exactly
//     once in the current open document" even though the supplied context
//     would have disambiguated it. Fixing an anonymous chunk means anchoring
//     on its body, not its header.
//   * context_before/context_after must match the text IMMEDIATELY around
//     expected_text, so borrowing another chunk's header as context is
//     refused and an edit meant for one chunk cannot land in another.
//   * A correctly anchored edit inside an anonymous chunk changes the body
//     and nothing else: YAML, options header, inline expression, both
//     anonymous headers and all prose come back byte-identical.
//
// Constants are duplicated (not imported) from
// fixtures/fake-claude-provider-rmd-notebook-edge-cases.mjs -- keep both in
// sync if the scripted document ever changes.
const FENCE = '```';
const YAML_LINES = [
  '---',
  'title: "RAI notebook edge cases"',
  'author: "RAI"',
  'output: html_document',
  '---',
];
const OPTIONS_HEADER = `${FENCE}{r setup-labeled, echo=FALSE, warning=FALSE}`;
const ANON_HEADER = `${FENCE}{r}`;
const INLINE_EXPRESSION = '`r rai_nb_total`';
const INLINE_LINE = `The computed total is ${INLINE_EXPRESSION} in the middle of this sentence.`;
const CHUNK_SETUP = 'rai_nb_base <- 6L';
const CHUNK_ANON_ONE = 'rai_nb_factor <- 4L';
const CHUNK_ANON_TWO_ORIGINAL = 'rai_nb_total <- rai_nb_bse * rai_nb_factor';
const CHUNK_ANON_TWO_FIXED = 'rai_nb_total <- rai_nb_base * rai_nb_factor';
const EXPECTED_TOTAL = 24;

function rmdSource(anonTwoBody: string): string {
  return [
    ...YAML_LINES,
    '',
    'Intro prose above every chunk. The audit edit must not touch this line.',
    '',
    INLINE_LINE,
    '',
    OPTIONS_HEADER,
    CHUNK_SETUP,
    FENCE,
    '',
    'Prose between the labeled chunk and the first anonymous chunk.',
    '',
    ANON_HEADER,
    CHUNK_ANON_ONE,
    FENCE,
    '',
    'Prose between the two anonymous chunks.',
    '',
    ANON_HEADER,
    anonTwoBody,
    FENCE,
    '',
    'Closing prose below the last chunk.',
    '',
  ].join('\n');
}

const RMD_ORIGINAL = rmdSource(CHUNK_ANON_TWO_ORIGINAL);
const RMD_FIXED = rmdSource(CHUNK_ANON_TWO_FIXED);

type Structure = {
  yaml_block: string;
  options_header_line: string | null;
  inline_expression_line: string | null;
  fence_count: number;
  anonymous_header_count: number;
  total_lines: number;
};

type RmdEdgeCaseData = {
  step_log: Array<{ chunk?: string; step?: string; status: string }>;
  document_id: string;
  document_type: string | null;
  original_contents: string;
  structure_before: Structure;
  setup_result: { status: string };
  anon_one_result: { status: string };
  anon_two_first_result: { status: string; stderr?: string };
  ambiguous_header_error: string | null;
  wrong_context_error: string | null;
  contents_after_refusals: string;
  applied_contents: string;
  structure_after: Structure;
  anon_two_retest_result: { status: string };
  inline_value: string;
  inline_stdout: string | null;
  clear_result: { status: string; stdout?: string };
  anon_one_rerun: { status: string };
  anon_two_rerun: { status: string };
  ordered_values: { rai_nb_factor: string; rai_nb_total: string };
  reorder_stdout: string | null;
  environment_detail: { objects: Array<{ name: string; found: boolean }> };
};

function readData(file: string): RmdEdgeCaseData | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as RmdEdgeCaseData : null;
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

test.describe('RAI Assistant .Rmd notebook edge cases (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('audits a notebook with inline code, chunk options, anonymous chunks and YAML, fixing only the buggy chunk body', async ({ rstudioPage: page }) => {
    test.setTimeout(240000);

    raiTest = await setupScriptedRaiTest(
      'rmd-notebook-edge-cases',
      'fake-claude-provider-rmd-notebook-edge-cases.mjs',
      { 'notebook.Rmd': RMD_ORIGINAL },
      undefined,
      true,
    );

    await openScenarioProject(page, raiTest);

    const notebookPath = path.join(path.dirname(raiTest.projectFile), 'notebook.Rmd');
    await documentOpen(page, notebookPath);
    const editor = new AceEditor(page, '');
    await expect.poll(() => editor.getValue(), { timeout: 15000 }).toBe(RMD_ORIGINAL);

    await openAssistant(page);

    // Explicit Full Auto: no card is expected; the durable transcript below
    // still proves each native run and editor result.

    const dataFile = path.join(raiTest.stateDir, 'rmd-edge-cases-data.json');
    await expect.poll(() => readData(dataFile), { timeout: 210000, intervals: [1000] }).not.toBeNull();
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);
    const data = readData(dataFile)!;
    // The sandbox is removed by globalTeardown, so copy the MCP transcript
    // this asserts on into the run's artifacts before it disappears.
    const evidence = test.info().outputPath('rmd-edge-cases-data.json');
    fs.copyFileSync(dataFile, evidence);
    await test.info().attach('rmd-edge-cases-data.json', { path: evidence, contentType: 'application/json' });

    // --- The document really is an .Rmd carrying all four structures. ------
    expect(data.document_type).toBe('r_markdown');
    expect(data.original_contents).toBe(RMD_ORIGINAL);
    expect(data.structure_before.anonymous_header_count).toBe(2);
    expect(data.structure_before.options_header_line).toBe(OPTIONS_HEADER);
    expect(data.structure_before.inline_expression_line).toBe(INLINE_LINE);
    expect(data.structure_before.yaml_block).toBe(YAML_LINES.join('\n'));

    // --- Top-down audit: the labeled and first anonymous chunks ran clean,
    // the second anonymous chunk genuinely failed on its typo. -------------
    expect(data.setup_result.status).toBe('ok');
    expect(data.anon_one_result.status).toBe('ok');
    expect(data.anon_two_first_result.status).toBe('error');
    expect(data.anon_two_first_result.stderr).toContain('rai_nb_bse');

    // --- (c) The duplicated anonymous header cannot anchor an edit: refused
    // as non-unique, decided on expected_text before context is consulted. --
    expect(data.ambiguous_header_error).toMatch(/exactly once/i);

    // --- (c) Context must immediately surround expected_text, so another
    // chunk's header is refused as a mismatch. -----------------------------
    expect(data.wrong_context_error).toMatch(/context_before|context_after/i);

    // --- Both refusals left the buffer byte-identical. --------------------
    expect(data.contents_after_refusals).toBe(RMD_ORIGINAL);

    // --- The anchored edit changed the chunk body and NOTHING else. -------
    expect(data.applied_contents).toBe(RMD_FIXED);
    expect(data.applied_contents).toContain(`${ANON_HEADER}\n${CHUNK_ANON_TWO_FIXED}\n${FENCE}`);
    expect(data.applied_contents).not.toContain(CHUNK_ANON_TWO_ORIGINAL);

    // --- (b) The chunk options survived byte-identical -- not stripped, not
    // reordered, not partially consumed by the replacement. ----------------
    expect(data.structure_after.options_header_line).toBe(OPTIONS_HEADER);
    expect(data.structure_after.options_header_line).toBe(data.structure_before.options_header_line);
    expect(data.applied_contents).toContain(`${OPTIONS_HEADER}\n${CHUNK_SETUP}\n${FENCE}`);

    // --- (d) The YAML frontmatter is untouched. ---------------------------
    expect(data.structure_after.yaml_block).toBe(YAML_LINES.join('\n'));
    expect(data.structure_after.yaml_block).toBe(data.structure_before.yaml_block);

    // --- (a) The inline expression's own line is untouched. ---------------
    expect(data.structure_after.inline_expression_line).toBe(INLINE_LINE);
    expect(data.applied_contents).toContain(INLINE_EXPRESSION);

    // --- (c) Both anonymous headers are still present and intact. ---------
    expect(data.structure_after.anonymous_header_count).toBe(2);
    expect(data.structure_after.fence_count).toBe(data.structure_before.fence_count);
    expect(data.structure_before.fence_count).toBe(6);
    expect(data.structure_after.total_lines).toBe(data.structure_before.total_lines);
    await expect.poll(() => editor.getValue(), { timeout: 15000 }).toBe(RMD_FIXED);

    // --- The fix was retested in the real Console. ------------------------
    expect(data.anon_two_retest_result.status).toBe('ok');

    // --- (a) The inline `r rai_nb_total` expression now evaluates to the
    // value only a genuine fix can produce. --------------------------------
    expect(data.inline_value).toBe(String(EXPECTED_TOTAL));
    expect(data.inline_stdout).toContain(`RAI_NB_INLINE ${EXPECTED_TOTAL}`);

    // --- (c) Both anonymous chunks still execute correctly IN ORDER, from a
    // cleared state, so this recomputes rather than reading leftovers. -----
    expect(data.clear_result.stdout).toContain('RAI_NB_CLEARED FALSE');
    expect(data.anon_one_rerun.status).toBe('ok');
    expect(data.anon_two_rerun.status).toBe('ok');
    expect(data.ordered_values).toEqual({ rai_nb_factor: '4', rai_nb_total: String(EXPECTED_TOTAL) });
    expect(data.reorder_stdout).toContain(`RAI_NB_REORDER 4 ${EXPECTED_TOTAL}`);

    // --- Step ordering: audit top-down, both refusals, the anchored edit,
    // retest, inline check, then the ordered re-execution. -----------------
    expect(data.step_log.map((entry) => entry.chunk ?? entry.step)).toEqual([
      'setup-labeled', 'anon-one', 'anon-two-original',
      'edit_document-ambiguous-header', 'edit_document-wrong-context', 'edit_document',
      'anon-two-fixed', 'inline-expression',
      'clear-anonymous-bindings', 'anon-one-rerun', 'anon-two-rerun', 'anonymous-order-probe',
    ]);

    // --- Independently confirm the value in the live Environment pane. ----
    expect(data.environment_detail.objects.find((object) => object.name === 'rai_nb_total')?.found).toBe(true);
    const envPane = new EnvironmentPane(page);
    await executeCommand(page, 'activateEnvironment');
    await expect.poll(
      () => envPane.hasVariable('rai_nb_total', String(EXPECTED_TOTAL)),
      { timeout: TIMEOUTS.environmentUpdate, intervals: [TIMEOUTS.pollInterval] },
    ).toBe(true);

    // RAI saving is always on, so the anchored replacement is on disk as well as in the open buffer.
    expect(fs.readFileSync(notebookPath, 'utf8')).toBe(RMD_FIXED);
  });
});

