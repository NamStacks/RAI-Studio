import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import { executeCommand, getChatState } from '@utils/commands';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { sandboxHome, setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

const PROJECT_READY_TIMEOUT_MS = 60000;

// Derived-data contract against the real package:
// with Full Auto on, the Assistant reads an original input file and derives NEW
// objects/files through Console code with no approval card; a direct edit of
// the original object is refused outright (never a card) and leaves it intact;
// the input file hash is unchanged; every run's exact code lands in the durable
// ~/.raistudio/trace JSONL linked to its get_run_result. Fixture data only.
function traceRecords(): any[] {
  const dir = path.join(sandboxHome(), '.raistudio', 'trace');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean))
    .map((line) => JSON.parse(line));
}

test.describe('RAI Assistant derived data (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('derives new data through traced code and refuses a direct edit of the original', async ({ rstudioPage: page }) => {
    test.setTimeout(180000);
    const input = 'g,v\n1,2\n1,4\n2,6\n';
    const proposals = [
      { language: 'R', target: 'console', code: "rai_e2e_orig <- utils::read.csv('input.csv')" },
      { language: 'R', target: 'console', code: "rai_e2e_summary <- aggregate(v ~ g, data = rai_e2e_orig, FUN = mean)" },
      { language: 'R', target: 'console', code: "utils::write.csv(rai_e2e_summary, 'derived-summary.csv', row.names = FALSE)" },
      { language: 'R', target: 'console', code: "rai_e2e_orig$v <- 0" },
      { language: 'R', target: 'console', code: "utils::write.csv(rai_e2e_summary, 'input.csv')" },
      { language: 'R', target: 'console', code: "cat('RAI_E2E_ORIG_SUM', sum(rai_e2e_orig$v), '\\n')" },
    ];
    raiTest = await setupScriptedRaiTest('derived-data', 'fake-claude-provider-matrix.mjs',
      { 'input.csv': input }, { proposals }, true);
    const workspace = path.dirname(raiTest.projectFile);
    const inputPath = path.join(workspace, 'input.csv');
    const inputBefore = fs.readFileSync(inputPath);
    const traceBefore = traceRecords().length;

    await page.evaluate((projectFile) => (window as any).rstudio.project.open(projectFile), raiTest!.projectFile);
    await page.waitForFunction(
      ({ projectPath }) => (window as any).rstudio?.ready === true &&
        (window as any).rstudio?.project?.path?.() === projectPath,
      { projectPath: raiTest!.projectPath }, { timeout: PROJECT_READY_TIMEOUT_MS },
    );
    const consoleActions = new ConsolePaneActions(page);
    await consoleActions.clearConsole();
    await executeCommand(page, 'activateChat');
    await expect(page.locator("iframe[title='RAI Assistant']")).toBeVisible({ timeout: 15000 });
    await expect.poll(() => getChatState(page), { timeout: 60000, intervals: [1000] }).toBe('ready');

    const resultFile = path.join(raiTest.stateDir, 'results.json');
    await expect.poll(
      () => fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')).length : 0,
      { timeout: 90000, intervals: [500] },
    ).toBe(proposals.length);
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);
    const results = JSON.parse(fs.readFileSync(resultFile, 'utf8'));

    for (const index of [0, 1, 2]) {
      expect(results[index].result).toMatchObject({ status: 'ok', approval: 'autonomous' });
      expect(results[index].result.trace.queued_seq).toEqual(expect.any(Number));
      expect(results[index].result.trace.completed_seq).toEqual(expect.any(Number));
    }
    expect(results[1].result.data_effects.bindings_created).toEqual(['rai_e2e_summary']);
    expect(results[1].result.data_effects.originals_rebound).toEqual([]);
    expect(results[0].result.data_effects.input_files[0]).toMatchObject({ unchanged: true });

    // Direct edits of the original object / original file: refused, not queued.
    for (const index of [3, 4]) {
      expect(results[index].result.status).toBe('error');
      expect(JSON.stringify(results[index].result)).toMatch(/refused/);
      expect(results[index].result.run_id).toBeUndefined();
    }
    expect(results[5].result).toMatchObject({ status: 'ok', stdout: expect.stringContaining('RAI_E2E_ORIG_SUM 12') });

    expect(fs.readFileSync(inputPath).equals(inputBefore)).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'derived-summary.csv'))).toBe(true);

    const trace = traceRecords().slice(traceBefore);
    for (const index of [0, 1, 2, 5]) {
      const queued = trace.find((record) => record.event === 'run_queued' && record.code === proposals[index].code);
      expect(queued, proposals[index].code).toBeTruthy();
      expect(queued.run_id).toBe(results[index].result.run_id);
      expect(trace.some((record) => record.event === 'run_completed' && record.queued_seq === queued.seq)).toBe(true);
    }
    for (const index of [3, 4])
      expect(trace.some((record) => record.event === 'run_refused' && record.code === proposals[index].code)).toBe(true);
  });
});
