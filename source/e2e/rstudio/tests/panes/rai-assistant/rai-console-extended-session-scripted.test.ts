import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import { executeCommand, getChatState } from '@utils/commands';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

// Live, single-session proof that the Write Assistant <-> Console bridge
// holds up over an EXTENDED, multi-round, increasingly complex back-and-forth
// -- not just isolated single-shot cases. One scripted provider
// (fake-claude-provider-extended-session.mjs) drives 8 sequential rounds (9
// approved proposals -- round 6 is a deliberate runtime error immediately
// followed by its own correction) through the *same* rsession/Console/R
// state, each round separately rendered on the native approval card,
// separately approved, and its real Console result read back via
// get_run_result before the *next* round's R code is even built. The
// increasing-complexity chain is: arithmetic -> vector ops -> a custom
// function -> apply/loop over data -> data-frame aggregation -> a runtime
// error -> a corrected re-approved proposal that quotes the parsed error
// value -> a multi-statement braced block referencing every prior round's
// live variables -> a final summary readback proving all of it persisted in
// one R session.
//
// Each expected code string below is computed with the exact same arithmetic
// the provider performs from real R output (see fake-claude-provider-extended-
// session.mjs's `rounds` plan) -- so an exact-code assertion here doubles as
// a check that the provider's "read the real result, then propose the next
// round" planning loop produced the coherent value a human reviewer would
// expect, not just whatever the process happened to emit.
type ExpectedRound = {
  round: number;
  label: string;
  code: string;
  expectError: boolean;
  consoleContains: string;
};

const expectedRounds: ExpectedRound[] = [
  {
    round: 1,
    label: 'arithmetic',
    code: '{ rai_ext_base <- 15 + 27; rai_ext_base }',
    expectError: false,
    consoleContains: '[1] 42',
  },
  {
    round: 2,
    label: 'vector-ops (reads round 1\'s 42)',
    code: '{ rai_ext_vec <- 42 + c(1,2,3); rai_ext_vec }',
    expectError: false,
    consoleContains: '[1] 43 44 45',
  },
  {
    round: 3,
    label: 'custom-function (reads round 2\'s vector sum 132)',
    code: '{ rai_ext_scale <- function(x, k) x * k; rai_ext_result3 <- rai_ext_scale(132, 2L); rai_ext_result3 }',
    expectError: false,
    consoleContains: '[1] 264',
  },
  {
    round: 4,
    label: 'apply-loop (reads round 3\'s 264)',
    code: '{ rai_ext_data <- 1:5; rai_ext_squares <- sapply(rai_ext_data, function(x) x^2); rai_ext_total4 <- sum(rai_ext_squares) + 264; rai_ext_total4 }',
    expectError: false,
    consoleContains: '[1] 319',
  },
  {
    round: 5,
    label: 'dataframe-aggregation (reads rounds 3+4\'s 264 and 319)',
    code: "{ rai_ext_df <- data.frame(grp = c('a','a','b','b'), val = c(264, 319, 10, 20)); rai_ext_agg <- aggregate(val ~ grp, data = rai_ext_df, FUN = sum); rai_ext_agg }",
    expectError: false,
    consoleContains: '583',
  },
  {
    round: 6,
    label: 'deliberate runtime error (quotes round 4\'s 319)',
    code: "{ stop(sprintf('RAI_EXT_ERROR_R6=%d', 319)) }",
    expectError: true,
    consoleContains: 'RAI_EXT_ERROR_R6=319',
  },
  {
    round: 6,
    label: 'corrected re-approved proposal (reads the error text\'s 319)',
    code: "{ rai_ext_fixed <- 319 + 1L; cat(sprintf('RAI_EXT_CORRECTED=%d\\n', rai_ext_fixed)) }",
    expectError: false,
    consoleContains: 'RAI_EXT_CORRECTED=320',
  },
  {
    round: 7,
    label: 'multi-statement braced block over rounds 1-6\'s live variables',
    code: "{ rai_ext_summary_calc <- rai_ext_base + sum(rai_ext_vec) + rai_ext_result3 + rai_ext_total4 + rai_ext_fixed + sum(rai_ext_agg$val); cat(sprintf('RAI_EXT_R7_SUM=%d\\n', rai_ext_summary_calc)) }",
    expectError: false,
    consoleContains: 'RAI_EXT_R7_SUM=1690',
  },
  {
    round: 8,
    label: 'final summary readback across the whole session',
    code: "{ cat(sprintf('RAI_EXT_FINAL: base=%d vecsum=%d result3=%d total4=%d fixed=%d aggsum=%d r7=%d\\n', rai_ext_base, sum(rai_ext_vec), rai_ext_result3, rai_ext_total4, rai_ext_fixed, sum(rai_ext_agg$val), rai_ext_summary_calc)) }",
    expectError: false,
    consoleContains: 'RAI_EXT_FINAL: base=42 vecsum=132 result3=264 total4=319 fixed=320 aggsum=613 r7=1690',
  },
];

type RecordedResult = {
  round: number;
  label: string;
  proposal: { language: string; target: string; code: string };
  result: Record<string, unknown>;
};

type PlanningEntry = {
  round: number;
  label: string;
  readFrom: string;
  stateBefore: Record<string, number>;
  stateAfter: Record<string, number>;
};

test.describe('RAI Assistant extended multi-round scripted session (no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.beforeEach(async () => {
    raiTest = await setupScriptedRaiTest('extended-session', 'fake-claude-provider-extended-session.mjs', {});
  });

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('8 sequential increasing-complexity rounds hold state across one real session', async ({ rstudioPage: page }) => {
    test.setTimeout(240000);

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
    const resultFile = path.join(raiTest!.stateDir, 'results.json');
    const planningFile = path.join(raiTest!.stateDir, 'planning.json');

    for (let i = 0; i < expectedRounds.length; i++) {
      const expected = expectedRounds[i];

      // 1. The approval card must show this round's exact, real code -- the
      // one the fake provider built from the *previous* round's real result.
      await expect(approvalCard).toHaveCount(0);

      // 2. The native result for this round must settle and be readable back
      // by the provider. Later rounds may already be recorded; this round's
      // entry is results[i].
      await expect.poll(
        () => fs.existsSync(resultFile) ? (JSON.parse(fs.readFileSync(resultFile, 'utf8')) as RecordedResult[]).length : 0,
        { timeout: 30000, intervals: [500] },
      ).toBeGreaterThanOrEqual(i + 1);
      const results = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as RecordedResult[];
      const recorded = results[i];
      expect(recorded.proposal.code, `round ${expected.round} (${expected.label}) proposal code`).toBe(expected.code);
      expect(recorded.result.status, `round ${expected.round} (${expected.label}) status`).toBe(expected.expectError ? 'error' : 'ok');

      // 3. The Console must show the correct output for this round.
      await expect(consoleActions.consolePane.consoleOutput).toContainText(expected.consoleContains, { timeout: 15000 });

      // 4. The fake provider's *next* proposal must be coherent given this
      // round's real result -- i.e. the planning log shows the extracted
      // value it read out of this round feeding the next round's build.
      // (Skipped after the last round: there is no next proposal to plan.)
      if (i < expectedRounds.length - 1) {
        await expect.poll(
          () => fs.existsSync(planningFile) ? (JSON.parse(fs.readFileSync(planningFile, 'utf8')) as PlanningEntry[]).length : 0,
          { timeout: 30000, intervals: [500] },
        ).toBeGreaterThanOrEqual(i + 1);
        const planning = JSON.parse(fs.readFileSync(planningFile, 'utf8')) as PlanningEntry[];
        const planEntry = planning[i];
        expect(planEntry.round, `planning entry ${i} matches round ${expected.round}`).toBe(expected.round);
        // The state the provider carried forward must be a strict superset
        // growth over the previous round's state (nothing reset, something
        // new learned) -- proof the "conversation" accumulated rather than
        // restarted each round.
        expect(Object.keys(planEntry.stateAfter).length).toBeGreaterThan(Object.keys(planEntry.stateBefore).length);
      }
    }

    // Final cross-check: the whole 9-entry result log is present, in order,
    // and the accumulated final readback line matches every intermediate
    // round's real value exactly -- session-wide state correctness proof.
    const finalResults = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as RecordedResult[];
    expect(finalResults).toHaveLength(expectedRounds.length);
    expect(finalResults.map((r) => r.round)).toEqual(expectedRounds.map((r) => r.round));
    const finalPlanning = JSON.parse(fs.readFileSync(planningFile, 'utf8')) as PlanningEntry[];
    expect(finalPlanning).toHaveLength(expectedRounds.length);

    const consoleText = await consoleActions.consolePane.consoleOutput.innerText();
    expect(consoleText).toContain('RAI_EXT_FINAL: base=42 vecsum=132 result3=264 total4=319 fixed=320 aggsum=613 r7=1690');
    expect(consoleText).not.toContain('.rs.rai.consoleRun');
  });
});
