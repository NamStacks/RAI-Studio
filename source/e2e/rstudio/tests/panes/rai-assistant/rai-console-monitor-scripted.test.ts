import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import { executeCommand, getChatState } from '@utils/commands';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

type MonitorData = {
  run_id: string;
  monitor_result: { status: string; run_id?: string };
  final_result: { status: string; stdout?: string };
  transcript: Array<{ tool: string; arguments: Record<string, unknown>; result: Record<string, unknown> }>;
};

function readData(file: string): MonitorData | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as MonitorData : null;
}

test.describe('RAI Assistant closed-loop Console monitor (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('observes an approved live Console run without resubmitting or interrupting R', async ({ rstudioPage: page }) => {
    test.setTimeout(150000);
    raiTest = await setupScriptedRaiTest('console-monitor', 'fake-claude-provider-console-monitor.mjs', {});

    await page.evaluate((projectFile) => { (window as any).rstudio.project.open(projectFile); }, raiTest.projectFile);
    await page.waitForFunction(
      ({ projectPath }) => (window as any).rstudio?.ready === true && (window as any).rstudio?.project?.path?.() === projectPath,
      { projectPath: raiTest.projectPath },
      { timeout: 60000 },
    );

    const consoleActions = new ConsolePaneActions(page);
    await consoleActions.clearConsole();
    await executeCommand(page, 'activateChat');
    const assistantFrameElement = page.locator("iframe[title='RAI Assistant']");
    await expect(assistantFrameElement).toBeVisible({ timeout: 15000 });
    await expect.poll(() => getChatState(page), { timeout: 60000, intervals: [1000] }).toBe('ready');
    const assistantFrame = page.frameLocator("iframe[title='RAI Assistant']");
    const runInspector = assistantFrame.locator('#run-inspector');
    const inspectorSnapshot = () => runInspector.evaluate((element) => ({
      hidden: (element as HTMLElement).hidden,
      state: (element as HTMLElement).dataset.state,
      text: (element.textContent ?? '').trim(),
      hasRawConsoleContent: /RAI_MONITOR_(?:START|DONE)/.test(element.textContent ?? ''),
      controlCount: element.querySelectorAll('button, input, textarea').length,
    }));

    await expect(page.locator('.rai-approval-card')).toHaveCount(0);

    await expect(runInspector).toBeVisible({ timeout: 15000 });
    await expect.poll(inspectorSnapshot, { timeout: 15000, intervals: [100] }).toMatchObject({
      hidden: false,
      state: 'running',
      text: expect.stringMatching(
        /^running · elapsed \d+s · quiet \d+s · output [1-9]\d* B \(\+\d+ B\) · deadline \d+s$/,
      ),
      hasRawConsoleContent: false,
      controlCount: 0,
    });

    const dataFile = path.join(raiTest.stateDir, 'console-monitor-data.json');
    await expect.poll(() => readData(dataFile), { timeout: 130000, intervals: [500] }).not.toBeNull();
    const data = readData(dataFile)!;
    expect(data.monitor_result.status).toBe('not_running');
    expect(data.monitor_result.run_id).toBe(data.run_id);
    expect(data.final_result.status).toBe('ok');
    expect(data.final_result.stdout).toContain('RAI_MONITOR_DONE');
    await expect.poll(inspectorSnapshot, { timeout: 15000, intervals: [100] }).toMatchObject({
      hidden: false,
      state: 'settled',
      text: expect.stringMatching(
        /^settled · elapsed \d+s · quiet \d+s · output [1-9]\d* B \(\+\d+ B\) · deadline \d+s$/,
      ),
      hasRawConsoleContent: false,
      controlCount: 0,
    });
    // Retrying the same proposal while its approval card is visible is the
    // established idempotent handshake. Only one call may actually queue R,
    // and monitor must never invoke run_r after that queue transition.
    const queuedRunIndex = data.transcript.findIndex((entry) => entry.tool === 'run_r' && entry.result.status === 'queued');
    expect(queuedRunIndex).toBeGreaterThanOrEqual(0);
    expect(data.transcript.filter((entry) => entry.tool === 'run_r' && entry.result.status === 'queued')).toHaveLength(1);
    const monitorCalls = data.transcript.filter((entry) => entry.tool === 'monitor_console_run');
    // The native capture slot may clear before the final result is stored.
    // The fixture retries only that documented read-only pending transition.
    expect(monitorCalls.length).toBeGreaterThanOrEqual(1);
    expect(monitorCalls.every((entry) => entry.arguments.run_id === data.run_id)).toBe(true);
    expect(monitorCalls.slice(0, -1).every((entry) => entry.result.status === 'finalization_pending' && entry.result.completion_verified === false)).toBe(true);
    expect(monitorCalls.at(-1)?.result.status).toBe('not_running');
    expect(monitorCalls.at(-1)?.result.completion_verified).toBe(true);
    expect(data.transcript.indexOf(monitorCalls[0])).toBeGreaterThan(queuedRunIndex);
    expect(data.transcript.slice(queuedRunIndex + 1).some((entry) => entry.tool === 'run_r')).toBe(false);
    expect(data.transcript.some((entry) => /interrupt|kill/.test(entry.tool))).toBe(false);
    await expect(consoleActions.consolePane.consoleOutput).toContainText('RAI_MONITOR_DONE', { timeout: 15000 });
  });
});
