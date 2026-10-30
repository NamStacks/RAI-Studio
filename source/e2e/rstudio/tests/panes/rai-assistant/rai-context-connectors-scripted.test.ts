import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import type { Page } from 'playwright';
import { executeCommand, getChatState } from '@utils/commands';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { EnvironmentPane } from '@pages/environment_pane.page';
import { PlotsPane } from '@pages/plots_pane.page';
import { TIMEOUTS } from '@utils/constants';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_PNG_BYTES = 4 * 1024 * 1024;

// Seeded through the harness's own Console helper -- never through an MCP
// tool -- so the connectors are demonstrably reading pre-existing session
// state rather than state they caused.
const SEED_ENVIRONMENT_R =
  "{ rai_ctx_df <- data.frame(gene = c('TP53', 'EGFR', 'BRCA1'), " +
  "count = c(10L, 20L, 30L), score = c(1.5, 2.5, 3.5), stringsAsFactors = FALSE); " +
  "rai_ctx_vec <- 1:5 }";
const SEED_FIRST_PLOT_R = "plot(1:4, type = 'b', main = 'RAI_CTX_PLOT_ONE')";
const SEED_SECOND_PLOT_R = "plot(4:1, type = 'b', main = 'RAI_CTX_PLOT_TWO')";

// Cell values the environment connector must never return. It reports class,
// dimensions, and column names only, so a gene symbol appearing anywhere in
// its response would mean it had read the data.
const CELL_VALUES = ['TP53', 'EGFR', 'BRCA1'];

type ToolEntry = {
  method?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  response?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

type ManifestEntry = { path: string; kind: string; size_bytes: number };
type BindingEntry = { name: string; binding: string; class: string[] };
type ColumnEntry = { name: string; class: string[] };

type ObjectDetail = {
  name: string;
  found: boolean;
  binding?: string;
  summary?: string;
  class?: string[];
  dims?: number[];
  row_count?: number;
  column_count?: number;
  columns?: ColumnEntry[];
  columns_truncated?: boolean;
};

type ImageMetadata = {
  type: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
  signature: number[];
};

type ContextConnectorsData = {
  project_response: { result?: { content?: Array<{ text?: string }> } };
  project_result: {
    project_active: boolean;
    root_name: string;
    working_directory: string | null;
  };
  environment_listing: {
    bindings: BindingEntry[];
    binding_count: number;
    total_count: number;
    truncated: boolean;
    max_bindings: number;
  };
  environment_listing_response: Record<string, unknown>;
  environment_detail: { objects: ObjectDetail[] };
  environment_detail_response: Record<string, unknown>;
  plot_history: {
    count: number;
    active_index: number | null;
    plots: Array<{ index: number; rendered: boolean }>;
    truncated: boolean;
    max_plots: number;
  };
  indexed_image?: ImageMetadata;
  indexed_image_index?: number;
  per_index: Array<{ index: number; rendered: boolean; ok: boolean; error_message?: string }>;
  out_of_range_error?: { code?: number; message?: string };
  transcript: ToolEntry[];
};

function readData(file: string): ContextConnectorsData | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as ContextConnectorsData : null;
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

test.describe('RAI Assistant read-only context connectors (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('reports project, environment, and plot-history context that matches the real IDE panes, without running R', async ({ rstudioPage: page }) => {
    test.setTimeout(180000);

    raiTest = await setupScriptedRaiTest(
      'context-connectors',
      'fake-claude-provider-context-connectors.mjs',
      {
        'analysis.R': "# seeded by the test harness\nrai_ctx_noop <- function() invisible(NULL)\n",
        'notes.md': '# notes\n',
        '.Renviron': 'RAI_CTX_SECRET=must-not-be-listed\n',
      },
      { object_names: ['rai_ctx_df', 'rai_ctx_vec', 'rai_ctx_absent'] },
    );

    // Two manifest shapes the flat `files` map above cannot express: one file a
    // level down (which must appear) and one two levels down (which must not).
    const projectDir = path.dirname(raiTest.projectFile);
    fs.mkdirSync(path.join(projectDir, 'data', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'data', 'cohort.csv'), 'gene,count\nTP53,10\n');
    fs.writeFileSync(path.join(projectDir, 'data', 'nested', 'too-deep.csv'), 'a\n1\n');

    await openScenarioProject(page, raiTest);

    // --- Establish IDE state through the ordinary, non-MCP harness path -----
    const consoleActions = new ConsolePaneActions(page);
    await page.locator('#rstudio_tb_clearplots').dispatchEvent('click').catch(() => {});
    await consoleActions.clearConsole();

    await consoleActions.executeInConsole(SEED_ENVIRONMENT_R, { wait: true });
    await consoleActions.executeInConsole(SEED_FIRST_PLOT_R, { wait: true });
    await consoleActions.executeInConsole(SEED_SECOND_PLOT_R, { wait: true });

    // The Environment pane must actually show the seeded objects before the
    // connector is asked about them, so the comparison below is against real
    // rendered pane state rather than an assumption about R.
    const envPane = new EnvironmentPane(page);
    await executeCommand(page, 'activateEnvironment');
    await expect.poll(
      () => envPane.hasVariable('rai_ctx_df', '3 obs'),
      { timeout: TIMEOUTS.environmentUpdate, intervals: [TIMEOUTS.pollInterval] },
    ).toBe(true);
    expect(await envPane.hasVariable('rai_ctx_vec', 'int')).toBe(true);

    const plotsPane = new PlotsPane(page);
    await executeCommand(page, 'activatePlots');
    await expect(plotsPane.plotImage).toBeVisible({ timeout: 20000 });
    // Two plots were drawn, so the Plots pane itself offers a "previous plot"
    // step -- the pane's own evidence that a history exists to be reported.
    await expect.poll(
      () => page.evaluate(() => (window as any).rstudio.commands.previousPlot.isEnabled() as boolean),
      { timeout: 20000, intervals: [TIMEOUTS.pollInterval] },
    ).toBe(true);

    // Baseline captured only after all state exists: everything the connectors
    // do from here must leave the Console untouched.
    const baselineConsole = await consoleActions.consolePane.consoleOutput.innerText();
    const promptCountBefore = await page.evaluate(() => (window as any).rstudio.console.promptCount as number);

    await openAssistant(page);
    const dataFile = path.join(raiTest.stateDir, 'context-connectors-data.json');
    await expect.poll(() => readData(dataFile), { timeout: 60000, intervals: [500] }).not.toBeNull();
    const data = readData(dataFile)!;

    // Surface a tool-level MCP error directly. Without this, a binary that
    // predates these connectors answers every call with "unknown tool" and the
    // first real assertion below fails on an `undefined` field, which reads as
    // a bad expectation rather than a stale app under test. Scoped to the calls
    // that must succeed: the get_plot_image probes below deliberately include
    // indexes expected to be rejected.
    const MUST_SUCCEED = ['get_project_context', 'get_environment_summary', 'get_plot_history'];
    for (const entry of data.transcript) {
      if (!entry.tool || !MUST_SUCCEED.includes(entry.tool)) continue;
      expect(
        { tool: entry.tool, error: (entry.response as { error?: { message?: string } })?.error?.message },
        `${entry.tool} returned an MCP error`,
      ).toEqual({ tool: entry.tool, error: undefined });
    }

    // --- No proposal, no approval, no execution ----------------------------
    expect(data.transcript.filter((entry) => entry.tool === 'run_r')).toHaveLength(0);
    expect(data.transcript.filter((entry) => entry.tool === 'get_run_result')).toHaveLength(0);
    expect(data.transcript.filter((entry) => entry.tool === 'edit_document')).toHaveLength(0);
    await expect(page.locator('.rai-approval-card')).toBeHidden();

    // --- get_project_context ----------------------------------------------
    const projectCalls = data.transcript.filter((entry) => entry.tool === 'get_project_context');
    expect(projectCalls).toHaveLength(1);
    expect(projectCalls[0].arguments).toEqual({});

    const project = data.project_result;
    expect(project.project_active).toBe(true);
    expect(project.root_name).toBe('workspace');
    expect(project.working_directory).toBe('.');
    // Project membership never authorizes a disk crawl. Only active metadata is
    // exposed; actual source text remains limited to already-open buffers.
    const projectText = JSON.stringify(data.project_response);
    expect(projectText).not.toContain(projectDir);
    expect(projectText).not.toContain('RAI_CTX_SECRET');
    expect(projectText).not.toContain('rai_ctx_noop');

    // --- get_environment_summary (listing) --------------------------------
    const listing = data.environment_listing;
    expect(listing.max_bindings).toBe(100);
    expect(listing.binding_count).toBe(listing.bindings.length);
    expect(listing.total_count).toBeGreaterThanOrEqual(listing.binding_count);

    const bindings = new Map(listing.bindings.map((binding) => [binding.name, binding]));
    expect(bindings.get('rai_ctx_df')?.binding).toBe('value');
    expect(bindings.get('rai_ctx_df')?.class).toEqual(['data.frame']);
    expect(bindings.get('rai_ctx_vec')?.binding).toBe('value');
    for (const binding of listing.bindings)
      expect(Object.keys(binding).sort()).toEqual(['binding', 'class', 'name']);

    // The listing agrees with what the Environment pane is showing.
    expect(await envPane.hasVariable('rai_ctx_df', '3 obs')).toBe(true);

    // --- get_environment_summary (named data-object detail) ----------------
    const detail = new Map(data.environment_detail.objects.map((object) => [object.name, object]));
    const frame = detail.get('rai_ctx_df')!;
    expect(frame.found).toBe(true);
    expect(frame.binding).toBe('value');
    expect(frame.class).toEqual(['data.frame']);
    expect(frame.dims).toEqual([3, 3]);
    expect(frame.row_count).toBe(3);
    expect(frame.column_count).toBe(3);
    expect(frame.columns_truncated).toBe(false);
    const sampled = { scope: 'first_rows', inspected_rows: 3, missing_count: 0 };
    expect(frame.columns).toEqual([
      { name: 'gene', class: ['character'], missingness: sampled },
      { name: 'count', class: ['integer'], missingness: sampled },
      { name: 'score', class: ['numeric'], missingness: sampled },
    ]);

    expect(detail.get('rai_ctx_vec')?.class).toEqual(['integer']);
    // A name that does not exist is reported as not found, never invented.
    expect(detail.get('rai_ctx_absent')?.found).toBe(false);

    // Class/dims/columns/summary and bounded prefix missing counts only -- no cell value leaves.
    const environmentText = JSON.stringify(data.environment_detail_response) +
      JSON.stringify(data.environment_listing_response);
    for (const value of CELL_VALUES)
      expect(environmentText).not.toContain(value);

    // --- get_plot_history + indexed get_plot_image -------------------------
    const historyCalls = data.transcript.filter((entry) => entry.tool === 'get_plot_history');
    expect(historyCalls).toHaveLength(1);
    expect(historyCalls[0].arguments).toEqual({});

    const history = data.plot_history;
    expect(history.count).toBe(2);
    expect(history.active_index).toBe(1);
    expect(history.truncated).toBe(false);
    expect(history.max_plots).toBe(100);
    expect(history.plots.map((entry) => entry.index)).toEqual([0, 1]);
    expect(history.plots[1].rendered).toBe(true);

    // The indexed read used the index the history itself reported.
    expect(data.indexed_image_index).toBe(history.active_index);
    expect(data.indexed_image).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      signature: PNG_SIGNATURE,
    });
    expect(data.indexed_image!.byteLength).toBeGreaterThan(PNG_SIGNATURE.length);
    expect(data.indexed_image!.byteLength).toBeLessThanOrEqual(MAX_PNG_BYTES);

    const indexedCall = data.transcript.filter(
      (entry) => entry.tool === 'get_plot_image' && (entry.arguments as { index?: number })?.index === history.active_index,
    );
    expect(indexedCall.length).toBeGreaterThan(0);
    const indexedResponse = indexedCall[0].response as { result?: { content?: Array<{ data?: string }> } };
    const png = Buffer.from(indexedResponse.result!.content![0].data!, 'base64');
    expect([...png.subarray(0, PNG_SIGNATURE.length)]).toEqual(PNG_SIGNATURE);
    expect(png.byteLength).toBe(data.indexed_image!.byteLength);
    expect(crypto.createHash('sha256').update(png).digest('hex')).toBe(data.indexed_image!.sha256);

    // The whole point of get_plot_history's `rendered` flag: it truthfully
    // predicts which indexes get_plot_image can serve without re-rendering.
    expect(data.per_index.map((entry) => entry.index)).toEqual([0, 1]);
    for (const entry of data.per_index) {
      expect(entry.ok).toBe(entry.rendered);
      if (!entry.rendered)
        expect(entry.error_message).toContain('no already-rendered image');
    }

    // An index past the end of the live history is rejected natively.
    expect(data.out_of_range_error).toMatchObject({
      code: -32603,
      message: expect.stringContaining('index is outside the current plot history'),
    });

    // --- Nothing reached the Console, and the panes did not move ----------
    const consoleText = await consoleActions.consolePane.consoleOutput.innerText();
    expect(consoleText).toBe(baselineConsole);
    expect(consoleText).not.toContain('get_project_context');
    expect(consoleText).not.toContain('get_environment_summary');
    expect(consoleText).not.toContain('get_plot_history');
    expect(await page.evaluate(() => (window as any).rstudio.console.promptCount as number)).toBe(promptCountBefore);

    // Reading the history did not navigate the Plots pane: the active plot is
    // still the one the user was looking at.
    await executeCommand(page, 'activatePlots');
    await expect(plotsPane.plotImage).toBeVisible();
    expect(await page.evaluate(() => (window as any).rstudio.commands.nextPlot.isEnabled() as boolean)).toBe(false);
  });
});
