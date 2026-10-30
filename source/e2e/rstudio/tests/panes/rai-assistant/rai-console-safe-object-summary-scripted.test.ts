import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import { executeCommand, getChatState } from '@utils/commands';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

const SEED_OBJECT_R_CODE = "{ rai_s1_object <- data.frame(id = 1:3, label = c('a', 'b', 'c')); makeActiveBinding('rai_s1_active', function(value) stop('RAI_S1_ACTIVE_FORCED'), .GlobalEnv); delayedAssign('rai_s1_delayed', stop('RAI_S1_DELAYED_FORCED'), assign.env = .GlobalEnv) }";
const SAFE_OBJECT_R_CODE = "stop('RAI_S1_OBJECT_SUMMARY_ERROR')";
const OBJECT_NAMES = ['rai_s1_object', 'rai_s1_active', 'rai_s1_delayed'];
const FORCED_MARKERS = ['RAI_S1_ACTIVE_FORCED', 'RAI_S1_DELAYED_FORCED'];

type ToolEntry = {
  tool: string;
  arguments: Record<string, unknown>;
  response: Record<string, unknown>;
  result: Record<string, unknown>;
};

type SafeObjectData = {
  proposal: { language: string; target: string; code: string };
  object_names: string[];
  run_id: string;
  run_result: Record<string, unknown>;
  debug: Record<string, unknown>;
  debug_response: Record<string, unknown>;
  transcript: ToolEntry[];
  progression: Array<{ phase: string; run_id?: string; status?: string }>;
};

function readData(file: string): SafeObjectData | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as SafeObjectData : null;
}

function unpromptConsoleInput(text: string): string {
  return text.replace(/(^|\n)[>+] ?/g, '$1');
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

test.describe('RAI Assistant Stage 1 safe object summaries (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('reads requested object metadata and truthful traceback availability after one raw failing Console input', async ({ rstudioPage: page }) => {
    test.setTimeout(150000);
    raiTest = await setupScriptedRaiTest(
      'safe-object-summary',
      'fake-claude-provider-safe-object-summary.mjs',
      {},
    );
    await page.evaluate((projectFile) => { (window as any).rstudio.project.open(projectFile); }, raiTest.projectFile);
    await page.waitForFunction(
      ({ expectedProjectPath }) => (window as any).rstudio?.ready === true &&
        (window as any).rstudio?.project?.path?.() === expectedProjectPath,
      { expectedProjectPath: raiTest.projectPath },
      { timeout: 60000 },
    );

    const consoleActions = new ConsolePaneActions(page);
    await consoleActions.clearConsole();
    // Fixture-only user Console setup: the Assistant must never be asked to
    // create active/delayed bindings in an explicit environment. Their safe
    // read-only summary is still exercised after its independently gated run.
    await consoleActions.executeInConsole(SEED_OBJECT_R_CODE, { wait: true });
    await expect(consoleActions.consolePane.consoleOutput).not.toContainText('Error: RAI_S1_ACTIVE_FORCED');
    const baselineConsole = await consoleActions.consolePane.consoleOutput.innerText();
    const promptCountBefore = await page.evaluate(() => (window as any).rstudio.console.promptCount as number);

    await executeCommand(page, 'activateChat');
    await expect(page.locator("iframe[title='RAI Assistant']")).toBeVisible({ timeout: 15000 });
    await expect.poll(() => getChatState(page), { timeout: 60000, intervals: [1000] }).toBe('ready');

    await expect(page.locator('.rai-approval-card')).toHaveCount(0);

    const evidenceFile = path.join(raiTest.stateDir, 'safe-object-summary-data.json');
    await expect.poll(() => readData(evidenceFile), { timeout: 30000, intervals: [500] }).not.toBeNull();
    const data = readData(evidenceFile)!;

    expect(data.proposal).toEqual({ language: 'R', target: 'console', code: SAFE_OBJECT_R_CODE });
    expect(data.object_names).toEqual(OBJECT_NAMES);
    expect(data.run_id).toMatch(/^run-[A-Za-z0-9-]+$/);
    expect(data.run_result).toMatchObject({ status: 'error', run_id: data.run_id });
    expect(JSON.stringify(data.run_result)).toContain('RAI_S1_OBJECT_SUMMARY_ERROR');

    // The native Stage 1 answer must describe normal values without evaluating
    // active/delayed bindings, and must not fabricate traceback frames.
    expect(data.debug).toMatchObject({
      status: 'error',
      run_id: data.run_id,
      traceback_available: false,
      traceback_unavailable_reason: expect.any(String),
      object_summaries: [
        { name: 'rai_s1_object', found: true, summary: expect.stringContaining('data.frame: 3 obs. of 2 variables') },
        { name: 'rai_s1_active', found: true, summary: expect.stringContaining('active binding') },
        { name: 'rai_s1_delayed', found: true, summary: expect.stringContaining('delayed binding') },
      ],
    });
    expect((data.debug.traceback_unavailable_reason as string).length).toBeGreaterThan(0);
    expect(data.debug).not.toHaveProperty('traceback');
    for (const marker of FORCED_MARKERS) {
      expect(JSON.stringify(data.debug)).not.toContain(marker);
      expect(JSON.stringify(data.run_result)).not.toContain(marker);
    }

    // Evidence retains every raw MCP response and proves result-driven order:
    // approval -> registered run -> terminal native error -> read-only debug.
    expect(data.progression.map((entry) => entry.phase)).toEqual(expect.arrayContaining([
      'run_registered', 'native_error_confirmed', 'debug_info_read',
    ]));
    const runCalls = data.transcript.filter((entry) => entry.tool === 'run_r');
    const resultCalls = data.transcript.filter((entry) => entry.tool === 'get_run_result');
    const debugCalls = data.transcript.filter((entry) => entry.tool === 'get_debug_info');
    expect(runCalls.some((entry) => entry.result.status === 'approval_required')).toBe(false);
    expect(runCalls.filter((entry) => entry.result.status !== 'approval_required')).toHaveLength(1);
    expect(resultCalls.at(-1)).toMatchObject({
      arguments: { run_id: data.run_id },
      result: { status: 'error', run_id: data.run_id },
    });
    expect(debugCalls).toHaveLength(1);
    expect(debugCalls[0].arguments).toEqual({ run_id: data.run_id, object_names: OBJECT_NAMES });
    expect(debugCalls[0].result).toMatchObject({ status: 'error', run_id: data.run_id });
    expect(debugCalls[0].response).toEqual(data.debug_response);
    const debugIndex = data.transcript.findIndex((entry) => entry.tool === 'get_debug_info');
    const terminalResultIndex = data.transcript.reduce(
      (last, entry, index) => entry.tool === 'get_run_result' && entry.result.status === 'error' ? index : last,
      -1,
    );
    expect(debugIndex).toBeGreaterThan(terminalResultIndex);
    expect(data.transcript.slice(debugIndex + 1).some((entry) => entry.tool === 'run_r')).toBe(false);

    const consoleText = await consoleActions.consolePane.consoleOutput.innerText();
    const rawConsole = unpromptConsoleInput(consoleText);
    expect(consoleText).not.toBe(baselineConsole);
    expect(countOccurrences(rawConsole, SAFE_OBJECT_R_CODE)).toBe(1);
    expect(consoleText).not.toContain('.rs.rai.consoleRun');
    expect(consoleText).not.toContain('get_debug_info');
    for (const marker of FORCED_MARKERS)
      expect(consoleText).not.toContain(`Error: ${marker}`);

    // get_debug_info completed before this check. The one prompt increment and
    // one source echo prove it did not add a Console helper, wrapper, or input.
    await expect.poll(
      () => page.evaluate(() => (window as any).rstudio.console.promptCount as number),
      { timeout: 15000, intervals: [100] },
    ).toBe(promptCountBefore + 1);
  });
});
