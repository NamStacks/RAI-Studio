import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import type { Page } from 'playwright';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { executeCommand, getChatState } from '@utils/commands';
import { EnvironmentPane } from '@pages/environment_pane.page';
import { PlotsPane } from '@pages/plots_pane.page';
import { TIMEOUTS } from '@utils/constants';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

// Regression guard for the "no new figure" half of the figure-inspection
// protocol. The existing plot fixtures (plot-image, slow-run-recovery) only
// cover a chunk that DOES draw. Neither covers the far more common audit step
// -- a chunk that draws nothing -- and that is exactly where the protocol can
// silently lie, because get_plot_image with no index always returns whatever
// is currently ACTIVE, which after a pure-computation chunk is still the
// PREVIOUS chunk's figure.
//
// OBSERVED BEHAVIOR, asserted here rather than assumed:
//
//   * get_plot_history is byte-for-byte unchanged across a chunk that draws
//     nothing (same count, same active_index, same per-index rendered flags).
//     That comparison is the only sound "no new figure" signal.
//   * get_plot_image called after that same chunk returns the EXACT SAME PNG
//     as before it -- proven by SHA-256 over the decoded bytes, so this is
//     identity and not resemblance. It does not fail, and it does not report
//     absence: a client that treated those bytes as the chunk's own output
//     would be reporting a stale figure from an earlier chunk.

type PlotHistory = {
  count: number;
  active_index: number | null;
  plots: Array<{ index: number; rendered: boolean }>;
  truncated: boolean;
  max_plots: number;
};

type Digest = { digest: string | null; bytes: number; error: string | null };

type PlotAbsenceData = {
  step_log: Array<Record<string, unknown>>;
  history_baseline: PlotHistory;
  plot_run: { status: string };
  history_after_plot: PlotHistory;
  digest_after_plot: Digest;
  no_plot_run: { status: string; stdout?: string };
  history_after_no_plot: PlotHistory;
  digest_after_no_plot: Digest;
  history_unchanged: boolean;
  active_image_is_stale: boolean;
  environment_detail: { objects: Array<{ name: string; found: boolean }> };
};

function readData(file: string): PlotAbsenceData | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as PlotAbsenceData : null;
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

test.describe('RAI Assistant plot-absence audit (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('reports no new figure for a chunk that draws nothing, and proves get_plot_image alone would have returned the previous chunk stale', async ({ rstudioPage: page }) => {
    test.setTimeout(180000);

    raiTest = await setupScriptedRaiTest(
      'plot-absence-audit',
      'fake-claude-provider-plot-absence-audit.mjs',
      {},
      undefined,
      true,
    );

    await openScenarioProject(page, raiTest);
    await openAssistant(page);

    const approvalCard = page.locator('.rai-approval-card');
    await expect(approvalCard).toHaveCount(0);
    await expect.poll(
      () => fs.existsSync(path.join(raiTest!.stateDir, 'awaiting-user-plot')),
      { timeout: 30000 },
    ).toBe(true);
    const consoleActions = new ConsolePaneActions(page);
    await consoleActions.executeInConsole("plot(1:5, main = 'RAI_PLOT_ABSENCE_FIRST')", { wait: true });
    fs.writeFileSync(path.join(raiTest!.stateDir, 'user-plot-ready'), '1');

    const dataFile = path.join(raiTest.stateDir, 'plot-absence-data.json');
    await expect.poll(() => readData(dataFile), { timeout: 150000, intervals: [1000] }).not.toBeNull();
    const data = readData(dataFile)!;
    // The sandbox is removed by globalTeardown, so copy the MCP transcript
    // this asserts on into the run's artifacts before it disappears.
    const evidence = test.info().outputPath('plot-absence-data.json');
    fs.copyFileSync(dataFile, evidence);
    await test.info().attach('plot-absence-data.json', { path: evidence, contentType: 'application/json' });

    // --- The plotting chunk added exactly one figure and it became active.
    // Measured as a DELTA against the baseline rather than against an empty
    // history: rstudioPage is worker-scoped, so one RStudio serves every spec
    // in a full-suite run, and how many figures the session has already drawn
    // is not this test's business. ------------------------------------------
    expect(data.plot_run.status).toBe('ok');
    expect(data.history_after_plot.count).toBe(data.history_baseline.count + 1);
    expect(data.history_after_plot.active_index).toBe(data.history_after_plot.count - 1);
    expect(data.history_after_plot.plots[data.history_after_plot.count - 1])
      .toEqual({ index: data.history_after_plot.count - 1, rendered: true });
    expect(data.digest_after_plot.digest).not.toBeNull();
    expect(data.digest_after_plot.bytes).toBeGreaterThan(0);

    // --- The no-plot chunk really ran and really computed something, so its
    // lack of a figure is not just a chunk that failed. ----------------------
    expect(data.no_plot_run.status).toBe('ok');
    expect(data.no_plot_run.stdout).toContain('55');
    expect(data.environment_detail.objects.find((o) => o.name === 'rai_plot_absence_value')?.found).toBe(true);

    // --- The sound "no new figure" signal: plot history is completely
    // unchanged across the chunk that drew nothing. -------------------------
    expect(data.history_unchanged).toBe(true);
    expect(data.history_after_no_plot).toEqual(data.history_after_plot);
    expect(data.history_after_no_plot.count).toBe(data.history_after_plot.count);
    expect(data.history_after_no_plot.active_index).toBe(data.history_after_plot.active_index);

    // --- The trap this test exists for: get_plot_image did NOT fail and did
    // NOT report absence. It returned the previous chunk's figure, byte-for-
    // byte identical. Absence must therefore be established from the history
    // comparison above, never from "an image came back". --------------------
    expect(data.active_image_is_stale).toBe(true);
    expect(data.digest_after_no_plot.digest).toBe(data.digest_after_plot.digest);
    expect(data.digest_after_no_plot.error).toBeNull();

    // --- The live Plots pane agrees: still exactly the one earlier figure,
    // and the Environment pane holds the no-plot chunk's value. -------------
    const plotsPane = new PlotsPane(page);
    await executeCommand(page, 'activatePlots');
    await expect(plotsPane.plotImage).toBeVisible({ timeout: 20000 });

    const envPane = new EnvironmentPane(page);
    await executeCommand(page, 'activateEnvironment');
    await expect.poll(
      () => envPane.hasVariable('rai_plot_absence_value', '55'),
      { timeout: TIMEOUTS.environmentUpdate, intervals: [TIMEOUTS.pollInterval] },
    ).toBe(true);
  });
});
