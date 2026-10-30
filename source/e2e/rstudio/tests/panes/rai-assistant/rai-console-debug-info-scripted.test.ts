import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import { executeCommand, getChatState } from '@utils/commands';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

const DEBUG_R_CODE = "{\n  warning('RAI_DEBUG_WARNING_ONE', call. = FALSE)\n  warning('RAI_DEBUG_WARNING_TWO', call. = FALSE)\n  stop('RAI_DEBUG_ERROR')\n}";

type ToolEntry = {
  tool: string;
  arguments: Record<string, unknown>;
  result: Record<string, unknown>;
};

type DebugData = {
  proposal: { language: string; target: string; code: string };
  run_id: string;
  run_result: Record<string, unknown>;
  debug: Record<string, unknown>;
  transcript: ToolEntry[];
};

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

// A Console echo prefixes the first source line with `>` and continuation
// lines with `+`. Strip only those display prefixes before comparing the raw
// submitted source; warning/error output remains untouched.
function unpromptConsoleInput(text: string): string {
  return text.replace(/(^|\n)[>+] ?/g, '$1');
}

function readDebugData(file: string): DebugData | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as DebugData : null;
}

test.describe('RAI Assistant Stage 1 debugging (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.beforeEach(async () => {
    raiTest = await setupScriptedRaiTest('debug-info', 'fake-claude-provider-debug-info.mjs', {});
  });

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('one approved failing R run yields read-only structured diagnostics without another Console input', async ({ rstudioPage: page }) => {
    test.setTimeout(150000);

    await page.evaluate((projectFile) => { (window as any).rstudio.project.open(projectFile); }, raiTest!.projectFile);
    await page.waitForFunction(
      ({ expectedProjectPath }) => (window as any).rstudio?.ready === true &&
        (window as any).rstudio?.project?.path?.() === expectedProjectPath,
      { expectedProjectPath: raiTest!.projectPath },
      { timeout: 60000 },
    );

    const consoleActions = new ConsolePaneActions(page);
    await consoleActions.clearConsole();
    const baselineConsole = await consoleActions.consolePane.consoleOutput.innerText();
    const promptCountBefore = await page.evaluate(() => (window as any).rstudio.console.promptCount as number);

    await executeCommand(page, 'activateChat');
    await expect(page.locator("iframe[title='RAI Assistant']")).toBeVisible({ timeout: 15000 });
    await expect.poll(() => getChatState(page), { timeout: 60000, intervals: [1000] }).toBe('ready');

    await expect(page.locator('.rai-approval-card')).toHaveCount(0);

    const debugFile = path.join(raiTest!.stateDir, 'debug-data.json');
    await expect.poll(() => readDebugData(debugFile), { timeout: 30000, intervals: [500] }).not.toBeNull();
    const data = readDebugData(debugFile)!;

    expect(data.proposal).toEqual({ language: 'R', target: 'console', code: DEBUG_R_CODE });
    expect(data.run_id).toMatch(/^run-[A-Za-z0-9-]+$/);

    // get_run_result is the native terminal record. It must be an error and
    // preserve both warning markers and the error marker in its captured text.
    expect(data.run_result).toMatchObject({ status: 'error', run_id: data.run_id });
    const nativeResultText = JSON.stringify(data.run_result);
    expect(nativeResultText).toContain('RAI_DEBUG_WARNING_ONE');
    expect(nativeResultText).toContain('RAI_DEBUG_WARNING_TWO');
    expect(nativeResultText).toContain('RAI_DEBUG_ERROR');

    // get_debug_info is textual reconstruction of stored Console capture, not
    // live condition/traceback introspection. Its error class is therefore the
    // documented inferred simpleError shape; no traceback is promised.
    expect(data.debug).toMatchObject({ status: 'error', run_id: data.run_id });
    expect(data.debug.error_detail).toMatchObject({
      message: expect.stringContaining('RAI_DEBUG_ERROR'),
      class: expect.arrayContaining(['simpleError', 'error', 'condition']),
    });
    expect(data.debug).not.toHaveProperty('traceback');
    expect(data.debug.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('RAI_DEBUG_WARNING_ONE') }),
      expect.objectContaining({ message: expect.stringContaining('RAI_DEBUG_WARNING_TWO') }),
    ]));
    expect((data.debug.warnings as unknown[])).toHaveLength(2);

    const runCalls = data.transcript.filter((entry) => entry.tool === 'run_r');
    const settledRunCalls = runCalls.filter((entry) => entry.result.status !== 'approval_required');
    const resultCalls = data.transcript.filter((entry) => entry.tool === 'get_run_result');
    const debugCalls = data.transcript.filter((entry) => entry.tool === 'get_debug_info');
    expect(runCalls.some((entry) => entry.result.status === 'approval_required')).toBe(false);
    expect(settledRunCalls).toHaveLength(1);
    expect(resultCalls.at(-1)?.result).toMatchObject({ status: 'error', run_id: data.run_id });
    expect(debugCalls).toHaveLength(1);
    expect(debugCalls[0].arguments).toEqual({ run_id: data.run_id });
    expect(debugCalls[0].result).toMatchObject({ status: 'error', run_id: data.run_id });
    const debugCallIndex = data.transcript.findIndex((entry) => entry.tool === 'get_debug_info');
    const lastResultCallIndex = data.transcript.reduce(
      (lastIndex, entry, index) => entry.tool === 'get_run_result' ? index : lastIndex,
      -1,
    );
    expect(debugCallIndex).toBeGreaterThan(lastResultCallIndex);
    expect(data.transcript.slice(debugCallIndex + 1).some((entry) => entry.tool === 'run_r')).toBe(false);

    const consoleText = await consoleActions.consolePane.consoleOutput.innerText();
    const rawConsoleInputs = unpromptConsoleInput(consoleText);
    expect(consoleText).not.toBe(baselineConsole);
    expect(countOccurrences(rawConsoleInputs, DEBUG_R_CODE)).toBe(1);
    expect(consoleText).not.toContain('.rs.rai.consoleRun');
    expect(consoleText).not.toContain('get_debug_info');

    // `promptCount` advances once per submitted Console command. Reading the
    // settled result and debug info has completed by now, so this proves those
    // read-only MCP calls did not enqueue a helper/wrapper or second input.
    await expect.poll(
      () => page.evaluate(() => (window as any).rstudio.console.promptCount as number),
      { timeout: 15000, intervals: [100] },
    ).toBe(promptCountBefore + 1);
  });
});
