import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import type { Page } from 'playwright';
import { executeCommand, getChatState } from '@utils/commands';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

const PLOT_R_CODE = "{ plot(c(1, 4, 9, 16), type = 'b', pch = 19, col = 'steelblue', main = 'RAI_STAGE2_PLOT') }";
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_PNG_BYTES = 4 * 1024 * 1024;

type ToolEntry = {
  tool?: string;
  arguments?: Record<string, unknown>;
  response?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

type McpResponse = {
  result?: { content?: Array<{ type?: string; mimeType?: string; data?: string }> };
  error?: { code?: number; message?: string };
};

type PlotImageData = {
  mode: 'plot' | 'no-plot';
  plot?: {
    proposal: { language: string; target: string; code: string };
    result: Record<string, unknown>;
  };
  image_response: McpResponse;
  image?: {
    type: string;
    mimeType: string;
    byteLength: number;
    sha256: string;
    signature: number[];
  };
  image_error?: Record<string, unknown>;
  transcript: ToolEntry[];
};

function readData(file: string): PlotImageData | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as PlotImageData : null;
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

// Console source echoes prefix the first line with `>` and continuation lines
// with `+`; strip display prefixes only, leaving the raw submitted source.
function unpromptConsoleInput(text: string): string {
  return text.replace(/(^|\n)[>+] ?/g, '$1');
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

test.describe('RAI Assistant Stage 2 get_plot_image (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('rejects get_plot_image with no active plot and never enters the Console', async ({ rstudioPage: page }) => {
    test.setTimeout(120000);
    raiTest = await setupScriptedRaiTest(
      'plot-image-no-active-plot',
      'fake-claude-provider-plot-image.mjs',
      {},
      { mode: 'no-plot' },
    );
    await openScenarioProject(page, raiTest);

    // This is a UI-only cleanup, not an R Console action. It makes the test
    // independent of any plot history in a reused desktop worker.
    await page.locator('#rstudio_tb_clearplots').dispatchEvent('click').catch(() => {});

    const consoleActions = new ConsolePaneActions(page);
    await consoleActions.clearConsole();
    const baselineConsole = await consoleActions.consolePane.consoleOutput.innerText();
    const promptCountBefore = await page.evaluate(() => (window as any).rstudio.console.promptCount as number);

    await openAssistant(page);
    const dataFile = path.join(raiTest.stateDir, 'plot-image-data.json');
    await expect.poll(() => readData(dataFile), { timeout: 30000, intervals: [500] }).not.toBeNull();
    const data = readData(dataFile)!;

    expect(data.mode).toBe('no-plot');
    expect(data.plot).toBeUndefined();
    expect(data.transcript.filter((entry) => entry.tool === 'run_r')).toHaveLength(0);
    expect(data.transcript.filter((entry) => entry.tool === 'get_run_result')).toHaveLength(0);
    const imageCalls = data.transcript.filter((entry) => entry.tool === 'get_plot_image');
    expect(imageCalls).toHaveLength(1);
    expect(imageCalls[0].arguments).toEqual({});
    expect(data.image_response.error).toMatchObject({
      code: -32603,
      message: expect.stringContaining('there is no active RStudio plot'),
    });
    // Preserve the raw JSON-RPC rejection envelope; get_plot_image does not
    // have a text tool-result envelope on this failure path.
    expect(data.image_error).toMatchObject({
      code: -32603,
      message: expect.stringContaining('there is no active RStudio plot'),
    });
    await expect(page.locator('.rai-approval-card')).toBeHidden();
    expect(await consoleActions.consolePane.consoleOutput.innerText()).toBe(baselineConsole);
    expect(await page.evaluate(() => (window as any).rstudio.console.promptCount as number)).toBe(promptCountBefore);
  });

  test('plot() is refused by the effect contract and get_plot_image stays empty', async ({ rstudioPage: page }) => {
    test.setTimeout(150000);
    raiTest = await setupScriptedRaiTest(
      'plot-image-active-plot',
      'fake-claude-provider-plot-image.mjs',
      {},
      { mode: 'plot' },
    );
    await openScenarioProject(page, raiTest);

    const consoleActions = new ConsolePaneActions(page);
    await consoleActions.clearConsole();
    const baselineConsole = await consoleActions.consolePane.consoleOutput.innerText();
    const promptCountBefore = await page.evaluate(() => (window as any).rstudio.console.promptCount as number);

    await openAssistant(page);
    const approvalCard = page.locator('.rai-approval-card');
    await expect(approvalCard).toHaveCount(0);

    const dataFile = path.join(raiTest.stateDir, 'plot-image-data.json');
    await expect.poll(() => readData(dataFile), { timeout: 30000, intervals: [500] }).not.toBeNull();
    const data = readData(dataFile)!;

    expect(data.mode).toBe('plot');
    expect(data.plot).toMatchObject({
      proposal: { language: 'R', target: 'console', code: PLOT_R_CODE },
      result: { message: expect.stringMatching(/no approved effect contract/) },
    });
    expect(data.plot!.result.run_id).toBeUndefined();
    const runCalls = data.transcript.filter((entry) => entry.tool === 'run_r');
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].result?.status).not.toBe('approval_required');
    const imageCalls = data.transcript.filter((entry) => entry.tool === 'get_plot_image');
    expect(imageCalls).toHaveLength(1);
    expect(imageCalls[0].arguments).toEqual({});
    expect(data.image).toBeUndefined();
    expect(data.image_error).toMatchObject({
      code: -32603,
      message: expect.stringContaining('there is no active RStudio plot'),
    });
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);
    expect(await consoleActions.consolePane.consoleOutput.innerText()).toBe(baselineConsole);
    expect(await page.evaluate(() => (window as any).rstudio.console.promptCount as number)).toBe(promptCountBefore);
  });
});

