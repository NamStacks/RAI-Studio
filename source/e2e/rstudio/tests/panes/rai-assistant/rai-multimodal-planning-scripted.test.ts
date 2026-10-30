import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import { executeCommand, getChatState } from '@utils/commands';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

// Multi-step, multi-modal proof requested directly: does RAI Assistant plan
// its next Console step from the REAL previous Console output (not a canned
// script), across increasing code complexity, including a deliberate error
// + correction, and finish by reading back a real rendered plot image?
//
// The scripted provider (fake-claude-provider-multimodal.mjs) computes each
// round's R code FROM the actual result of the previous round -- e.g. round
// 2's vector math literally interpolates round 1's parsed stdout value, not
// a value hardcoded in the test. Round 3 is a deliberate runtime error;
// round 4's correction reads round 2's real value and ignores the failed
// round 3 attempt, proving the loop distinguishes error from success before
// deciding what to do next. Round 6 proposes a plot whose title embeds every
// prior round's real values. plot() has no approved effect contract, so the
// proposal is refused, and get_plot_image then reports that no plot exists.
//
// Valid run_r proposals (rounds 1 to 5) are admitted without an approval card;
// this test waits for those five native Console runs and the refused plot,
// then asserts on the final JSON transcript the provider writes to disk.
type RoundRecord = {
  round: number;
  label: string;
  code: string;
  result: { status: string; stdout?: string; value?: unknown; run_id?: string; message?: string };
  readValue: number | null;
};

type MultimodalData = {
  rounds: RoundRecord[];
  image: { type: string; mimeType: string; byteLength: number; sha256: string; signature: number[] };
  image_error: Record<string, unknown>;
  transcript: Array<{ tool?: string; arguments?: { proposal?: { code?: string } }; result?: Record<string, unknown> }>;
};

function readData(file: string): MultimodalData | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as MultimodalData : null;
}

test.describe('RAI Assistant multi-step multi-modal planning (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('plans each round from real prior Console output, recovers from an induced error, and refuses the plot without an approved effect contract', async ({ rstudioPage: page }) => {
    test.setTimeout(300000);
    raiTest = await setupScriptedRaiTest('multimodal', 'fake-claude-provider-multimodal.mjs', {});

    await page.evaluate((projectFile) => {
      (window as any).rstudio.project.open(projectFile);
    }, raiTest!.projectFile);
    await page.waitForFunction(
      ({ projectPath }) => (window as any).rstudio?.ready === true &&
        (window as any).rstudio?.project?.path?.() === projectPath,
      { projectPath: raiTest!.projectPath },
      { timeout: 30000 },
    );

    const consoleActions = new ConsolePaneActions(page);
    await consoleActions.clearConsole();

    await executeCommand(page, 'activateChat');
    await expect(page.locator("iframe[title='RAI Assistant']")).toBeVisible({ timeout: 15000 });
    await expect.poll(() => getChatState(page), { timeout: 60000, intervals: [1000] }).toBe('ready');

    const approvalCard = page.locator('.rai-approval-card');
    // Valid run_r is admitted without a card. Five proposals reach the Console
    // as separate native runs; the sixth (the plot) is refused.
    await expect(approvalCard).toHaveCount(0);

    const dataFile = path.join(raiTest.stateDir, 'multimodal-data.json');
    await expect.poll(() => readData(dataFile), { timeout: 60000, intervals: [500] }).not.toBeNull();
    const data = readData(dataFile)!;

    expect(data.rounds).toHaveLength(6);

    // Round 1: baseline arithmetic settles cleanly.
    expect(data.rounds[0]).toMatchObject({ round: 1, label: 'arithmetic' });
    expect(data.rounds[0].result.status).toBe('ok');
    expect(data.rounds[0].readValue).toBe(42);

    // Round 2's code must literally contain round 1's real value (42), not
    // a value the test pre-computed independently -- this is read from the
    // provider's own generated code string, proving genuine "plan from
    // output" behavior rather than a fixed script.
    expect(data.rounds[1].code).toContain('42 + c(1,2,3)');
    expect(data.rounds[1].result.status).toBe('ok');
    expect(data.rounds[1].readValue).toBe(132); // sum(43,44,45)

    // Round 3 is a deliberate runtime error.
    expect(data.rounds[2].label).toBe('deliberate-error');
    expect(data.rounds[2].result.status).toBe('error');

    // Round 4's correction must read round 2's REAL value (132), never a
    // value derived from the failed round 3 attempt.
    expect(data.rounds[3].code).toContain('rai_mm_scale(132, 2L)');
    expect(data.rounds[3].result.status).toBe('ok');
    expect(data.rounds[3].readValue).toBe(264);

    // Round 5 aggregates round 1 (42) and round 4 (264) together: 42+264+10=316.
    expect(data.rounds[4].code).toContain('c(42, 264, 10)');
    expect(data.rounds[4].result.status).toBe('ok');
    expect(data.rounds[4].readValue).toBe(316);

    // Round 6 names the real prior values and is refused. plot() is not neutral.
    expect(data.rounds[5].code).toContain('v1=42 v2=132 v4=264 v5=316');
    expect(data.rounds[5].result.run_id).toBeUndefined();
    expect(String(data.rounds[5].result.message ?? '')).toMatch(/no approved effect contract/);

    const imageCallIndex = data.transcript.findIndex((entry) => entry.tool === 'get_plot_image');
    const plotCallIndex = data.transcript.findIndex((entry) =>
      entry.tool === 'run_r' && String(entry.arguments?.proposal?.code ?? '').includes('RAI_MM_PLOT'));
    expect(imageCallIndex).toBeGreaterThan(plotCallIndex);
    expect(data.image_error).toMatchObject({
      code: -32603,
      message: expect.stringContaining('there is no active RStudio plot'),
    });

    const consoleText = await consoleActions.consolePane.consoleOutput.innerText();
    expect(consoleText).not.toContain('RAI_MM_PLOT');
    expect(consoleText).not.toContain('.rs.rai.consoleRun');
  });
});

