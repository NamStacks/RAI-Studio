import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import type { Page } from 'playwright';
import { executeCommand, getChatState } from '@utils/commands';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { SourcePaneActions } from '@actions/source_pane.actions';
import { VIEWER_TAB, VIEWER_FRAME } from '@pages/viewer_pane.page';
import { PlotsPane } from '@pages/plots_pane.page';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

// Long interactive R Notebook / .Rmd session, exercised entirely through the
// real Source-pane chunk-execution path (never through MCP run_r), followed
// by a single bounded, read-only RAI MCP inspection pass over the resulting
// live session: a large data.frame's schema (never its rows), the plot
// history built from two heavy-but-deterministic base plots, and the
// htmltools Viewer widget state. See rai-context-connectors-scripted.test.ts
// and rai-viewer-state-scripted.test.ts for the connector contracts this
// composes; see rnotebook.test.ts / rmarkdown_chunks.test.ts for the
// Source-pane chunk-execution conventions this reuses.

const TABLE_VAR = 'rai_notebook_df';
const TABLE_ROWS = 20000;
const TABLE_COLS = 8;
const EXPECTED_COLUMN_NAMES = ['id', 'group', 'value1', 'value2', 'value3', 'flag', 'category', 'score'];
// Values a schema-only connector must never leak: sampled category/group
// labels that only ever exist inside actual cell data, never in class/dims
// metadata.
const RAW_VALUE_MARKERS = ['cat1', 'cat2', 'letters', 'RAI_TABLE_DIMS'];

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_PNG_BYTES = 4 * 1024 * 1024;
const BOUNDED_VIEWER_KEYS = ['active', 'kind', 'transport'];
const RAW_VIEWER_MARKERS = ['http://', 'https://', '.html', '/tmp/', 'file://', 'C:\\\\', 'RAI_NOTEBOOK_VIEWER_WIDGET', '<p', '<div'];

const NOTEBOOK_CONTENT = [
  '---',
  'title: "RAI Heavy Notebook Artifacts"',
  'output: html_notebook',
  '---',
  '',
  '```{r bigtable}',
  'set.seed(42)',
  `${TABLE_VAR} <- data.frame(`,
  '  id = 1:20000,',
  '  group = sample(letters[1:5], 20000, replace = TRUE),',
  '  value1 = round(rnorm(20000), 3),',
  '  value2 = round(runif(20000), 3),',
  '  value3 = round(rexp(20000), 3),',
  '  flag = sample(c(TRUE, FALSE), 20000, replace = TRUE),',
  '  category = sample(paste0("cat", 1:10), 20000, replace = TRUE),',
  '  score = round(rnorm(20000, mean = 50, sd = 10), 2)',
  ')',
  `cat(sprintf("RAI_TABLE_DIMS %d %d\\n", nrow(${TABLE_VAR}), ncol(${TABLE_VAR})))`,
  '```',
  '',
  '```{r plots}',
  'set.seed(123)',
  `plot(${TABLE_VAR}$value1[1:500], ${TABLE_VAR}$value2[1:500], main = "RAI_NOTEBOOK_SCATTER", pch = 19, col = "steelblue")`,
  `hist(${TABLE_VAR}$score, breaks = 30, main = "RAI_NOTEBOOK_HIST", col = "tomato")`,
  'cat("RAI_PLOTS_DONE\\n")',
  '```',
  '',
  '```{r widget}',
  'htmltools::html_print(htmltools::tags$div(htmltools::tags$p("RAI_NOTEBOOK_VIEWER_WIDGET")))',
  'cat("RAI_WIDGET_DONE\\n")',
  '```',
].join('\n');

type ToolEntry = {
  method?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  response?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

type ColumnEntry = { name: string; class: string[] | string };

type EnvironmentDetail = {
  name: string;
  found: boolean;
  class?: string[] | string;
  dims?: number[];
  row_count?: number;
  column_count?: number;
  columns?: ColumnEntry[];
  columns_truncated?: boolean;
};

type PlotHistory = {
  count: number;
  active_index: number | null;
  plots: Array<{ index: number; rendered: boolean }>;
};

type ImageMetadata = { type: string; mimeType: string; byteLength: number; sha256: string; signature: number[] };

type NotebookHeavyArtifactsData = {
  environment_listing_response: Record<string, unknown>;
  environment_detail: { objects: EnvironmentDetail[] };
  environment_detail_response: Record<string, unknown>;
  plot_history: PlotHistory;
  plot_history_response: Record<string, unknown>;
  plot_images: Array<{ index: number; image: ImageMetadata }>;
  viewer_result: Record<string, unknown>;
  viewer_response: { result?: { content?: Array<{ text?: string }> }; error?: unknown };
  transcript: ToolEntry[];
};

function readData(file: string): NotebookHeavyArtifactsData | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as NotebookHeavyArtifactsData : null;
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

test.describe('RAI Assistant heavy Notebook/.Rmd IDE artifacts (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('runs a 3-chunk Notebook (large table, heavy plots, Viewer widget) via the Source pane, then inspects it read-only through bounded RAI MCP', async ({ rstudioPage: page }) => {
    test.setTimeout(300000);

    const consoleActions = new ConsolePaneActions(page);
    const sourceActions = new SourcePaneActions(page, consoleActions);

    raiTest = await setupScriptedRaiTest(
      'notebook-heavy-artifacts',
      'fake-claude-provider-notebook-heavy-artifacts.mjs',
      {},
      { table_var: TABLE_VAR },
    );
    await openScenarioProject(page, raiTest);

    const missingPackages = await consoleActions.ensurePackages(['rmarkdown', 'htmltools'], 180000);
    test.skip(
      missingPackages.length > 0,
      `required R package(s) not available: ${missingPackages.join(', ')}`,
    );

    await consoleActions.resetSourcePane();
    await consoleActions.clearConsole();

    const fileName = `rai_notebook_heavy_${Date.now()}.Rmd`;
    await sourceActions.createAndOpenFile(fileName, NOTEBOOK_CONTENT);
    await expect(sourceActions.sourcePane.selectedTab).toContainText(fileName, { timeout: 20000 });
    await sourceActions.ensureSourceMode();

    // --- Chunk 1: create the large table; visible inline output plus the
    // exact Console completion signal prove it actually ran (not just typed).
    await consoleActions.clearConsole();
    await sourceActions.navigateToChunkByLabel('bigtable');
    await executeCommand(page, 'executeCurrentChunk');
    await expect(consoleActions.consolePane.consoleOutput).toContainText(
      `RAI_TABLE_DIMS ${TABLE_ROWS} ${TABLE_COLS}`, { timeout: 30000 },
    );

    // --- Chunk 2: htmltools Viewer widget, established purely through the
    // ordinary chunk-execution path. Execute it before plots: the Viewer
    // creation lifecycle can replace the active graphics display, while later
    // base plots do not expose Viewer content through MCP.
    await sourceActions.navigateToChunkByLabel('widget');
    await executeCommand(page, 'executeCurrentChunk');
    await expect(consoleActions.consolePane.consoleOutput).toContainText('RAI_WIDGET_DONE', { timeout: 30000 });
    await expect(page.locator(VIEWER_TAB)).toBeVisible({ timeout: 20000 });
    await expect(page.locator(VIEWER_FRAME)).toBeVisible({ timeout: 20000 });

    // --- Chunk 3: two heavy-but-deterministic base plots (scatter +
    // histogram). Both must render inline in the Source pane.
    await sourceActions.navigateToChunkByLabel('plots');
    await executeCommand(page, 'executeCurrentChunk');
    await expect(consoleActions.consolePane.consoleOutput).toContainText('RAI_PLOTS_DONE', { timeout: 30000 });
    await expect(sourceActions.sourcePane.chunkImage.first()).toBeVisible({ timeout: 30000 });
    await expect.poll(
      () => sourceActions.sourcePane.chunkImage.count(),
      { timeout: 15000, intervals: [500] },
    ).toBeGreaterThanOrEqual(2);

    // Notebook chunks render to their own per-chunk graphics device (see
    // NotebookPlots.R createNotebookGraphicsDevice), never the session's
    // main RStudio graphics display that the RAI plot-history/plot-image
    // connectors read (the same display the Plots pane shows). The inline
    // chunk images above already prove visible IDE chunk output; this
    // separate, ordinary non-MCP Console replay (same session, same data,
    // same base-R calls) is what populates the plot history the bounded
    // MCP inspection below reads -- the same pattern
    // rai-context-connectors-scripted.test.ts uses for its
    // SEED_FIRST_PLOT_R / SEED_SECOND_PLOT_R seeds.
    // Each desktop E2E sandbox begins with fresh plot state. Do not dispatch
    // Clear Plots here: it is asynchronous and can erase the two freshly
    // seeded main-display entries after their Console evaluations complete.
    await consoleActions.executeInConsole(
      `plot(${TABLE_VAR}$value1[1:500], ${TABLE_VAR}$value2[1:500], main = 'RAI_NOTEBOOK_SCATTER', pch = 19, col = 'steelblue')`,
      { wait: true },
    );
    await consoleActions.executeInConsole(
      `hist(${TABLE_VAR}$score, breaks = 30, main = 'RAI_NOTEBOOK_HIST', col = 'tomato')`,
      { wait: true },
    );
    const plotsPane = new PlotsPane(page);
    await executeCommand(page, 'activatePlots');
    await expect(plotsPane.plotImage).toBeVisible({ timeout: 20000 });

    // Baseline captured only after every chunk-driven artifact already
    // exists: everything the read-only MCP connectors do from here must
    // leave the Console and the live objects untouched.
    const baselineConsole = await consoleActions.consolePane.consoleOutput.innerText();
    const promptCountBefore = await page.evaluate(() => (window as any).rstudio.console.promptCount as number);

    await openAssistant(page);
    const dataFile = path.join(raiTest.stateDir, 'notebook-heavy-artifacts-data.json');
    await expect.poll(() => readData(dataFile), { timeout: 90000, intervals: [500] }).not.toBeNull();
    const data = readData(dataFile)!;

    const MUST_SUCCEED = ['get_environment_summary', 'get_plot_history', 'get_plot_image', 'get_viewer_state'];
    for (const entry of data.transcript) {
      if (!entry.tool || !MUST_SUCCEED.includes(entry.tool)) continue;
      expect(
        { tool: entry.tool, error: (entry.response as { error?: { message?: string } })?.error?.message },
        `${entry.tool} returned an MCP error: ${JSON.stringify(entry)}`,
      ).toEqual({ tool: entry.tool, error: undefined });
    }

    // --- No mutation path was ever used: this is a strictly read-only
    // inspection pass, so no run_r / edit_document call may appear anywhere.
    expect(data.transcript.filter((entry) => entry.tool === 'run_r')).toHaveLength(0);
    expect(data.transcript.filter((entry) => entry.tool === 'get_run_result')).toHaveLength(0);
    expect(data.transcript.filter((entry) => entry.tool === 'edit_document')).toHaveLength(0);
    await expect(page.locator('.rai-approval-card')).toBeHidden();

    // --- 1. Environment schema only: dims/columns, never rows/cell values ---
    const detail = data.environment_detail.objects.find((object) => object.name === TABLE_VAR);
    expect(detail?.found).toBe(true);
    expect(detail?.class).toEqual(['data.frame']);
    expect(detail?.dims).toEqual([TABLE_ROWS, TABLE_COLS]);
    expect(detail?.row_count).toBe(TABLE_ROWS);
    expect(detail?.column_count).toBe(TABLE_COLS);
    expect(detail?.columns_truncated).toBe(false);
    expect(detail?.columns?.map((column) => column.name)).toEqual(EXPECTED_COLUMN_NAMES);

    const environmentText = JSON.stringify(data.environment_detail_response) +
      JSON.stringify(data.environment_listing_response);
    for (const marker of RAW_VALUE_MARKERS)
      expect(environmentText).not.toContain(marker);
    // No literal numeric row count anywhere except inside the bounded
    // dims/row_count/column_count fields already asserted above -- the raw
    // response text must not additionally spell out any row values.
    expect(environmentText).not.toMatch(/"score"\s*:\s*\[/);

    // --- 2. Heavy plot history: at least 2 entries from the two base plots -
    const history = data.plot_history;
    expect(history.count).toBeGreaterThanOrEqual(2);
    expect(history.active_index).not.toBeNull();
    expect(history.plots.filter((entry) => entry.rendered).length).toBeGreaterThanOrEqual(1);

    // --- 3. Indexed PNG image reads, bounded to <= 4 MB, real PNG bytes ----
    expect(data.plot_images.length).toBeGreaterThanOrEqual(1);
    for (const { image } of data.plot_images) {
      expect(image).toMatchObject({ type: 'image', mimeType: 'image/png', signature: PNG_SIGNATURE });
      expect(image.byteLength).toBeGreaterThan(PNG_SIGNATURE.length);
      expect(image.byteLength).toBeLessThanOrEqual(MAX_PNG_BYTES);
    }

    // Reading plot history/images is read-only: the active index is
    // unchanged, and no run_r targeting plot() appears anywhere.
    expect(data.transcript.map((entry) => entry.arguments?.proposal)).not.toContainEqual(
      expect.objectContaining({ code: expect.stringContaining('plot(') }),
    );

    // --- 4. Viewer state: bounded active/kind/transport only, no URL/HTML --
    expect(data.viewer_result).toEqual({ active: true, kind: 'html_widget', transport: 'session_temp' });
    expect(Object.keys(data.viewer_result).sort()).toEqual([...BOUNDED_VIEWER_KEYS].sort());
    const viewerText = JSON.stringify(data.viewer_response);
    for (const marker of RAW_VIEWER_MARKERS)
      expect(viewerText.toLowerCase()).not.toContain(marker.toLowerCase());

    // --- No mutation, no DOM scraping: Console and live objects unchanged --
    const consoleText = await consoleActions.consolePane.consoleOutput.innerText();
    expect(consoleText).toBe(baselineConsole);
    expect(await page.evaluate(() => (window as any).rstudio.console.promptCount as number)).toBe(promptCountBefore);

    // The Notebook's own inline artifacts are still exactly as the chunks
    // left them -- the read-only inspection pass did not re-execute or
    // otherwise disturb the Source pane.
    await expect.poll(
      () => sourceActions.sourcePane.chunkImage.count(),
      { timeout: 5000 },
    ).toBeGreaterThanOrEqual(2);
    // Activating the Plots pane intentionally hides (but never scrapes,
    // reloads, or removes) the pre-existing Viewer iframe. Its bounded MCP
    // state was already asserted above; require DOM retention only here.
    await expect(page.locator(VIEWER_FRAME)).toHaveCount(1);

    await sourceActions.closeSourceAndDeleteFile(fileName);
    await consoleActions.executeInConsole(`unlink("${fileName.replace('.Rmd', '.nb.html')}")`, { wait: true });
  });
});
