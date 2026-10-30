import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import type { Page } from 'playwright';
import { documentOpen, executeCommand, getChatState } from '@utils/commands';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { EnvironmentPane } from '@pages/environment_pane.page';
import { PlotsPane } from '@pages/plots_pane.page';
import { AceEditor } from '@pages/ace_editor.page';
import { TIMEOUTS } from '@utils/constants';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

// Single comprehensive, credential-free workflow spanning every bounded RAI
// Assistant connector in one live session: bounded project-relative file
// read (with rejected traversal/absolute negatives), live open-editor
// inspection, Console execution/result, environment summary, read-only
// existing-plot PNG context, and one exact native buffer edit. See
// docs/plans/2026-08-10-rai-bounded-file-and-plot-context.md Task 4.

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_PNG_BYTES = 4 * 1024 * 1024;

const NOTES_CONTENTS = '# comprehensive workflow notes\nDo not modify this file.\n';
const ANALYSIS_R_ORIGINAL = "threshold <- 0.5\nmessage('keep this line')\n";
const ANALYSIS_R_EXPECTED_TEXT = 'threshold <- 0.5';
const ANALYSIS_R_REPLACEMENT_TEXT = 'threshold <- 0.9';
const ANALYSIS_R_EXPECTED_AFTER_EDIT = "threshold <- 0.9\nmessage('keep this line')\n";
const SEED_PLOT_R = "plot(1:5, type = 'b', main = 'RAI_COMPREHENSIVE_SEED_PLOT')";

type ToolEntry = {
  method?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  response?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

type ComprehensiveData = {
  file_read: { path: string; text: string; truncated: boolean };
  traversal_error: unknown;
  absolute_error: unknown;
  active_document: { active: boolean; document_id: string; type: string; dirty: boolean; read_only: boolean };
  open_documents: { documents: Array<{ document_id: string }> };
  open_document_before_edit: { contents: string };
  console_run_id: string;
  console_run_result: { status: string; stdout?: string };
  environment_listing: { bindings: Array<{ name: string; binding: string; class: string[] }> };
  environment_detail: { objects: Array<{ name: string; found: boolean; class?: string[] }> };
  plot_history_before: { count: number; active_index: number | null };
  plot_history_after: { count: number; active_index: number | null };
  plot_image: { type: string; mimeType: string; byteLength: number; sha256: string; signature: number[] };
  edit_document_id: string;
  applied_document_contents: string;
  transcript: ToolEntry[];
};

function readData(file: string): ComprehensiveData | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as ComprehensiveData : null;
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

test.describe('RAI Assistant comprehensive context workflow (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('reads a bounded project file, inspects the open editor, runs and reads Console/environment/plot context, and applies one exact buffer edit', async ({ rstudioPage: page }) => {
    test.setTimeout(240000);

    raiTest = await setupScriptedRaiTest(
      'comprehensive-context',
      'fake-claude-provider-comprehensive-context.mjs',
      {
        'notes.txt': NOTES_CONTENTS,
        'analysis.R': ANALYSIS_R_ORIGINAL,
      },
      undefined,
      true,
    );

    await openScenarioProject(page, raiTest);

    // --- Seed the plot through the ordinary, non-MCP Console harness path,
    // exactly like rai-context-connectors-scripted.test.ts, so get_plot_image
    // below demonstrably reads pre-existing state it did not cause. ---------
    const consoleActions = new ConsolePaneActions(page);
    await page.locator('#rstudio_tb_clearplots').dispatchEvent('click').catch(() => {});
    await consoleActions.clearConsole();
    await consoleActions.executeInConsole(SEED_PLOT_R, { wait: true });

    const plotsPane = new PlotsPane(page);
    await executeCommand(page, 'activatePlots');
    await expect(plotsPane.plotImage).toBeVisible({ timeout: 20000 });

    // Open the R document the edit will target, so the Assistant's active
    // document context reflects the real open editor tab.
    await documentOpen(page, path.join(path.dirname(raiTest.projectFile), 'analysis.R'));
    const editor = new AceEditor(page, '');
    await expect.poll(() => editor.getValue(), { timeout: 15000 }).toBe(ANALYSIS_R_ORIGINAL);

    // Track the raw notes.txt bytes on disk to prove the file-read leg never
    // mutates project files -- only analysis.R changes, through the saved edit.
    const notesPath = path.join(path.dirname(raiTest.projectFile), 'notes.txt');
    const notesBefore = fs.readFileSync(notesPath, 'utf8');

    await openAssistant(page);

    // This fixture explicitly enables Full Auto. No card may appear; the
    // provider must observe the same native edit through to applied + trace.
    const approvalCard = page.locator('.rai-approval-card');
    const dataFile = path.join(raiTest.stateDir, 'comprehensive-data.json');
    await expect.poll(() => readData(dataFile), { timeout: 90000, intervals: [500] }).not.toBeNull();
    await expect(approvalCard).toHaveCount(0);
    const data = readData(dataFile)!;

    // Surface any MCP tool-level error directly so a stale/missing endpoint
    // reads as an obvious failure rather than an opaque downstream assertion.
    const MUST_SUCCEED = [
      'read_project_file', 'get_active_document_context', 'list_open_documents',
      'read_open_document', 'run_r', 'get_run_result', 'get_environment_summary',
      'get_plot_history', 'get_plot_image', 'edit_document',
    ];
    for (const entry of data.transcript) {
      if (!entry.tool || !MUST_SUCCEED.includes(entry.tool)) continue;
      if (entry.arguments?.path === '../notes.txt' || entry.arguments?.path === '/etc/hosts') continue;
      expect(
        { tool: entry.tool, error: (entry.response as { error?: { message?: string } })?.error?.message },
        `${entry.tool} returned an MCP error: ${JSON.stringify(entry)}`,
      ).toEqual({ tool: entry.tool, error: undefined });
    }

    // --- 1. Bounded project-relative file read ------------------------------
    const fileCalls = data.transcript.filter((entry) => entry.tool === 'read_project_file');
    expect(fileCalls.map((entry) => entry.arguments?.path)).toEqual(
      expect.arrayContaining(['notes.txt', '../notes.txt', '/etc/hosts']),
    );
    expect(data.file_read).toMatchObject({ path: 'notes.txt', text: NOTES_CONTENTS, truncated: false });

    // --- 1b. Negative boundaries: traversal and absolute paths are rejected,
    // never returned as file contents, at the same live endpoint. ----------
    expect(JSON.stringify(data.traversal_error)).toMatch(/(project-relative|\.\.|absolute)/i);
    expect(JSON.stringify(data.traversal_error)).not.toContain(NOTES_CONTENTS.trim());
    expect(JSON.stringify(data.absolute_error)).toMatch(/(project-relative|absolute)/i);
    expect(JSON.stringify(data.absolute_error)).not.toContain('root:');

    // --- notes.txt itself is never mutated by any of the above -------------
    expect(fs.readFileSync(notesPath, 'utf8')).toBe(notesBefore);
    expect(fs.readFileSync(notesPath, 'utf8')).toBe(NOTES_CONTENTS);

    // --- 2. Live open-editor inspection -------------------------------------
    expect(data.active_document).toMatchObject({ active: true, type: 'r_source', read_only: false });
    expect(data.open_documents.documents.some((document) => document.document_id === data.active_document.document_id)).toBe(true);
    expect(data.open_document_before_edit.contents).toBe(ANALYSIS_R_ORIGINAL);

    // --- 3. Console execution / result --------------------------------------
    expect(data.console_run_result).toMatchObject({ status: 'ok' });
    expect(data.console_run_result.stdout).toContain('42');
    const runCalls = data.transcript.filter((entry) => entry.tool === 'run_r');
    // Full Auto may resolve the first response internally (without a visible
    // card), so the public wire response is either immediately queued or one
    // transient approval-required retry. In both cases exactly one native run
    // must be registered from the fixed proposal.
    expect(runCalls.every((entry) => (entry.arguments?.proposal as { code?: string } | undefined)?.code === '{ rai_comp_result <- 6L * 7L; print(rai_comp_result) }')).toBe(true);
    expect(runCalls.filter((entry) => typeof entry.result?.run_id === 'string')).toHaveLength(1);

    // The real Console pane agrees with the MCP-reported result.
    const consoleText = await consoleActions.consolePane.consoleOutput.innerText();
    expect(consoleText).toContain('rai_comp_result <- 6L * 7L');
    expect(consoleText).toContain('42');

    // --- 4. Environment summary ----------------------------------------------
    const bindings = new Map(data.environment_listing.bindings.map((binding) => [binding.name, binding]));
    expect(bindings.get('rai_comp_result')?.class).toEqual(['integer']);
    const envPane = new EnvironmentPane(page);
    await executeCommand(page, 'activateEnvironment');
    await expect.poll(
      () => envPane.hasVariable('rai_comp_result', '42L'),
      { timeout: TIMEOUTS.environmentUpdate, intervals: [TIMEOUTS.pollInterval] },
    ).toBe(true);
    const detail = new Map(data.environment_detail.objects.map((object) => [object.name, object]));
    expect(detail.get('rai_comp_result')?.found).toBe(true);
    expect(detail.get('rai_comp_result')?.class).toEqual(['integer']);

    // --- 5. Read-only existing-plot PNG context ------------------------------
    expect(data.plot_image).toMatchObject({ type: 'image', mimeType: 'image/png', signature: PNG_SIGNATURE });
    expect(data.plot_image.byteLength).toBeGreaterThan(PNG_SIGNATURE.length);
    expect(data.plot_image.byteLength).toBeLessThanOrEqual(MAX_PNG_BYTES);
    const imageCall = data.transcript.find((entry) => entry.tool === 'get_plot_image');
    const imageResponse = imageCall!.response as { result?: { content?: Array<{ data?: string }> } };
    const png = Buffer.from(imageResponse.result!.content![0].data!, 'base64');
    expect(crypto.createHash('sha256').update(png).digest('hex')).toBe(data.plot_image.sha256);

    // Reading the plot image is read-only: the plot history/active index is
    // identical before and after the call, and no plot() proposal (i.e. no
    // run_r targeting a plot) appears anywhere in the transcript.
    expect(data.plot_history_after).toMatchObject({
      count: data.plot_history_before.count,
      active_index: data.plot_history_before.active_index,
    });
    expect(runCalls.map((entry) => entry.arguments?.proposal)).not.toContainEqual(
      expect.objectContaining({ code: expect.stringContaining('plot(') }),
    );

    // MCP plot-history metadata plus PNG hash above prove the existing rendered
    // plot was read without a new plot proposal or active-index mutation. UI
    // screenshots are intentionally not compared: switching IDE panes can
    // rescale the same plot canvas without changing its native plot state.
    await executeCommand(page, 'activatePlots');
    await expect(plotsPane.plotImage).toBeVisible();

    // --- 6. Exact native buffer edit -----------------------------------------
    expect(data.edit_document_id).toBe(data.active_document.document_id);
    expect(data.applied_document_contents).toBe(ANALYSIS_R_EXPECTED_AFTER_EDIT);
    await expect.poll(() => editor.getValue(), { timeout: 15000 }).toBe(ANALYSIS_R_EXPECTED_AFTER_EDIT);
    // RAI saving is always on, so the applied buffer is saved and no longer dirty.
    await expect.poll(
      () => page.evaluate(() => (window as any).rstudio.documents.active()?.dirty as boolean),
      { timeout: 5000 },
    ).toBe(false);

    const editCalls = data.transcript.filter((entry) => entry.tool === 'edit_document');
    expect(editCalls.length).toBeGreaterThanOrEqual(2);
    for (const entry of editCalls) expect(entry.arguments).toEqual({
      document_id: data.active_document.document_id,
      expected_text: ANALYSIS_R_EXPECTED_TEXT,
      replacement: ANALYSIS_R_REPLACEMENT_TEXT,
    });
    expect(editCalls[0].result).toMatchObject({ status: 'applying', approval: 'autonomous' });
    expect(editCalls.at(-1)?.result).toMatchObject({ status: 'applied', trace: { seq: expect.any(Number) } });

    // RAI saving is always on, so the exact replacement is written to analysis.R; notes.txt stays unchanged.
    const analysisPath = path.join(path.dirname(raiTest.projectFile), 'analysis.R');
    expect(fs.readFileSync(analysisPath, 'utf8')).toBe(
      ANALYSIS_R_ORIGINAL.replace('threshold <- 0.5', ANALYSIS_R_REPLACEMENT_TEXT),
    );
    expect(fs.readFileSync(notesPath, 'utf8')).toBe(NOTES_CONTENTS);
  });
});

