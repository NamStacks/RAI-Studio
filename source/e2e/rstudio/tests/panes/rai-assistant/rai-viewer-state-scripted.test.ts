import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import { executeCommand, getChatState } from '@utils/commands';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

// Minimal, self-contained htmltools widget: a single <p> tag rendered via
// html_print(). htmltools ships as a transitive dependency of htmlwidgets/
// rmarkdown, which the RAI-Studio test image already carries for the
// htmlwidgets pane spec (tests/panes/viewer/htmlwidgets.test.ts), so no new
// package install is required. If htmltools is ever unavailable in a given
// test environment, scenario (B) below skips with an explanit reason rather
// than silently downgrading its assertions.
const VIEWER_R_CODE =
  "htmltools::html_print(htmltools::tags$p('RAI_STAGE3_VIEWER_STATE'))";

const BOUNDED_KEYS = ['active', 'kind', 'transport'];
const RAW_MARKERS = ['http://', 'https://', '.html', '/tmp/', 'file://', 'C:\\\\'];

type ToolEntry = {
  method?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  response?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

type ViewerStateData = {
  mode: 'inactive' | 'active';
  viewer_response: { result?: { content?: Array<{ type?: string; text?: string }> }; error?: unknown };
  viewer_result: Record<string, unknown>;
  transcript: ToolEntry[];
};

function readData(file: string): ViewerStateData | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as ViewerStateData : null;
}

function unpromptConsoleInput(text: string): string {
  return text.replace(/(^|\n)[>+] ?/g, '$1');
}

async function openAssistant(page: import('playwright').Page): Promise<void> {
  await executeCommand(page, 'activateChat');
  await expect(page.locator("iframe[title='RAI Assistant']")).toBeVisible({ timeout: 15000 });
  await expect.poll(() => getChatState(page), { timeout: 60000, intervals: [1000] }).toBe('ready');
}

async function openScenarioProject(
  page: import('playwright').Page,
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

test.describe('RAI Assistant Stage 3 get_viewer_state (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('reports inactive/none/none with no preceding R proposal and zero Console activity', async ({ rstudioPage: page }) => {
    test.setTimeout(120000);
    raiTest = await setupScriptedRaiTest(
      'viewer-state-inactive',
      'fake-claude-provider-viewer-state.mjs',
      {},
      { mode: 'inactive' },
    );
    await openScenarioProject(page, raiTest);

    const consoleActions = new ConsolePaneActions(page);
    await consoleActions.clearConsole();
    const baselineConsole = await consoleActions.consolePane.consoleOutput.innerText();
    const promptCountBefore = await page.evaluate(() => (window as any).rstudio.console.promptCount as number);

    await openAssistant(page);
    const dataFile = path.join(raiTest.stateDir, 'viewer-state-data.json');
    await expect.poll(() => readData(dataFile), { timeout: 30000, intervals: [500] }).not.toBeNull();
    const data = readData(dataFile)!;

    // No run_r proposal, no approval card, and no other tool preceded the
    // one get_viewer_state call.
    expect(data.transcript.filter((entry) => entry.tool === 'run_r')).toHaveLength(0);
    expect(data.transcript.filter((entry) => entry.tool === 'get_run_result')).toHaveLength(0);
    const viewerCalls = data.transcript.filter((entry) => entry.tool === 'get_viewer_state');
    expect(viewerCalls).toHaveLength(1);
    expect(viewerCalls[0].arguments).toEqual({});
    await expect(page.locator('.rai-approval-card')).toBeHidden();

    expect(data.mode).toBe('inactive');
    expect(data.viewer_result).toEqual({ active: false, kind: 'none', transport: 'none' });
    expect(Object.keys(data.viewer_result).sort()).toEqual([...BOUNDED_KEYS].sort());

    const rawText = JSON.stringify(data.viewer_response);
    for (const marker of RAW_MARKERS)
      expect(rawText.toLowerCase()).not.toContain(marker.toLowerCase());

    expect(await consoleActions.consolePane.consoleOutput.innerText()).toBe(baselineConsole);
    expect(await page.evaluate(() => (window as any).rstudio.console.promptCount as number)).toBe(promptCountBefore);
  });

  test('reports active/html_widget/session_temp for an existing Viewer widget established only by the test harness, read-only and with no further Console activity', async ({ rstudioPage: page }) => {
    test.setTimeout(150000);

    // htmltools is a transitive dependency of htmlwidgets/rmarkdown, already
    // required by tests/panes/viewer/htmlwidgets.test.ts in this same test
    // image; ensurePackage() confirms it's actually resolvable in this run
    // rather than assuming, and the test explains and skips if not.
    const setupActions = new ConsolePaneActions(page);

    raiTest = await setupScriptedRaiTest(
      'viewer-state-active',
      'fake-claude-provider-viewer-state.mjs',
      {},
      { mode: 'active' },
    );
    await openScenarioProject(page, raiTest);

    const htmltoolsAvailable = await setupActions.ensurePackage('htmltools', 60000);
    test.skip(
      !htmltoolsAvailable,
      'htmltools is unavailable in this test environment; no other minimal, ' +
      'deterministic html_widget viewer fixture is wired into this harness.',
    );

    // Establish Viewer content using ONLY the harness's normal non-MCP
    // console helper -- the same executeInConsole() path every other pane
    // spec uses (see htmlwidgets.test.ts). No MCP tool, no approval flow,
    // and no run_r proposal is involved in creating this Viewer state.
    await setupActions.executeInConsole(VIEWER_R_CODE, { wait: true });
    await expect(page.locator('#rstudio_workbench_tab_viewer')).toBeVisible({ timeout: 20000 });
    await expect(page.locator("iframe[title='Viewer Pane']")).toBeVisible({ timeout: 20000 });

    // Baseline is captured only after the Viewer content is established --
    // this proves the provider's later get_viewer_state call is genuinely
    // read-only against pre-existing state, not a trigger for new activity.
    const baselineConsole = await setupActions.consolePane.consoleOutput.innerText();
    const promptCountBefore = await page.evaluate(() => (window as any).rstudio.console.promptCount as number);

    await openAssistant(page);
    const dataFile = path.join(raiTest.stateDir, 'viewer-state-data.json');
    await expect.poll(() => readData(dataFile), { timeout: 30000, intervals: [500] }).not.toBeNull();
    const data = readData(dataFile)!;

    // The provider made exactly one tool call, and it happened strictly
    // after the Viewer baseline above (i.e. after this test independently
    // established Viewer state, not before and not via the MCP tool).
    expect(data.transcript.filter((entry) => entry.tool === 'run_r')).toHaveLength(0);
    const viewerCalls = data.transcript.filter((entry) => entry.tool === 'get_viewer_state');
    expect(viewerCalls).toHaveLength(1);
    expect(viewerCalls[0].arguments).toEqual({});
    await expect(page.locator('.rai-approval-card')).toBeHidden();

    expect(data.mode).toBe('active');
    expect(data.viewer_result).toEqual({ active: true, kind: 'html_widget', transport: 'session_temp' });
    expect(Object.keys(data.viewer_result).sort()).toEqual([...BOUNDED_KEYS].sort());

    // The raw MCP response never carries a URL, path, or HTML payload --
    // only the bounded active/kind/transport summary.
    const rawText = JSON.stringify(data.viewer_response);
    for (const marker of RAW_MARKERS)
      expect(rawText.toLowerCase()).not.toContain(marker.toLowerCase());
    expect(rawText).not.toContain('RAI_STAGE3_VIEWER_STATE');
    expect(rawText).not.toContain('<p');
    expect(data.viewer_response.result?.content?.[0]?.text ?? '').not.toMatch(/<[a-z][\s\S]*>/i);

    // The Console after the read-only get_viewer_state call is byte-for-byte
    // identical to the baseline captured once Viewer content already
    // existed: the call added no input, no prompt increment, and did not
    // scrape the Viewer iframe's DOM to validate its own response.
    const consoleText = await setupActions.consolePane.consoleOutput.innerText();
    expect(consoleText).toBe(baselineConsole);
    expect(unpromptConsoleInput(consoleText)).not.toContain('get_viewer_state');
    expect(await page.evaluate(() => (window as any).rstudio.console.promptCount as number)).toBe(promptCountBefore);
  });
});
