import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import { executeCommand, getChatState } from '@utils/commands';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

type Proposal = { language: 'R'; target: 'console'; code: string };
type Step = {
  label: string;
  code?: string;
  derive?: { tag: string; prefix: string; suffix: string };
  expect: { status: 'ok' | 'error'; stdout?: string; warnings?: string[]; error?: string };
};
type Scenario = { id: string; steps?: Step[]; debugOnlyIds?: unknown[] };
type ToolEntry = { tool: string; arguments: Record<string, unknown>; result: Record<string, unknown>; response: Record<string, unknown> };
type RunRecord = { label: string; proposal: Proposal; run_id: string; result: Record<string, unknown>; debug: Record<string, unknown> };
type Evidence = { runs: RunRecord[]; transcript: ToolEntry[]; planning: Array<{ label: string; feedback: string; code: string }> };

const R = (code: string): Proposal => ({ language: 'R', target: 'console', code });
const initialWarningThenError = "{\n  rai_s1_seed <- 40L\n  warning('S1_MULTILINE_WARNING', call. = FALSE)\n  stop('S1_MULTILINE_ERROR=40')\n}";
const dataframeError = "{\n  rai_s1_df <- data.frame(value = 1:2)\n  rai_s1_df[[3]]\n}";

const cases: Array<{ id: string; title: string; scenario: Scenario; expectedCodes: string[]; verify: (evidence: Evidence) => void }> = [
  {
    id: '01-clean-success', title: 'clean successful result has debug with no diagnostics',
    scenario: { id: '01-clean-success', steps: [{ label: 'clean', code: "cat('S1_CLEAN=42\\n')", expect: { status: 'ok', stdout: 'S1_CLEAN=42' } }] },
    expectedCodes: ["cat('S1_CLEAN=42\\n')"],
    verify: ({ runs }) => { expect(runs).toHaveLength(1); expect(runs[0].debug.warnings ?? []).toEqual([]); expect(runs[0].debug).not.toHaveProperty('error_detail'); },
  },
  {
    id: '02-one-warning', title: 'one warning is structured in debug output',
    scenario: { id: '02-one-warning', steps: [{ label: 'one-warning', code: "{ warning('S1_ONE_WARNING', call. = FALSE); cat('S1_ONE_DONE\\n') }", expect: { status: 'ok', stdout: 'S1_ONE_DONE', warnings: ['S1_ONE_WARNING'] } }] },
    expectedCodes: ["{ warning('S1_ONE_WARNING', call. = FALSE); cat('S1_ONE_DONE\\n') }"],
    verify: ({ runs }) => expect(runs[0].debug.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('S1_ONE_WARNING') })])),
  },
  {
    id: '03-multiple-warnings', title: 'multiple warnings are individually structured',
    scenario: { id: '03-multiple-warnings', steps: [{ label: 'two-warnings', code: "{ warning('S1_WARNING_A', call. = FALSE); warning('S1_WARNING_B', call. = FALSE); cat('S1_WARN_DONE\\n') }", expect: { status: 'ok', stdout: 'S1_WARN_DONE', warnings: ['S1_WARNING_A', 'S1_WARNING_B'] } }] },
    expectedCodes: ["{ warning('S1_WARNING_A', call. = FALSE); warning('S1_WARNING_B', call. = FALSE); cat('S1_WARN_DONE\\n') }"],
    verify: ({ runs }) => expect(runs[0].debug.warnings).toHaveLength(2),
  },
  {
    id: '04-callerless-stop', title: 'callerless stop error has structured error detail',
    scenario: { id: '04-callerless-stop', steps: [{ label: 'callerless-stop', code: "stop('S1_CALLERLESS_STOP')", expect: { status: 'error', error: 'S1_CALLERLESS_STOP' } }] },
    expectedCodes: ["stop('S1_CALLERLESS_STOP')"],
    verify: ({ runs }) => expect(runs[0].debug.error_detail).toMatchObject({ message: expect.stringContaining('S1_CALLERLESS_STOP') }),
  },
  {
    id: '05-function-call-error', title: 'Error in function call is preserved in diagnostics',
    scenario: { id: '05-function-call-error', steps: [{ label: 'function-call-error', code: "{ rai_s1_fail <- function() stop('S1_FUNCTION_CALL_ERROR'); rai_s1_fail() }", expect: { status: 'error', error: 'S1_FUNCTION_CALL_ERROR' } }] },
    expectedCodes: ["{ rai_s1_fail <- function() stop('S1_FUNCTION_CALL_ERROR'); rai_s1_fail() }"],
    verify: ({ runs }) => expect(JSON.stringify(runs[0].debug)).toContain('S1_FUNCTION_CALL_ERROR'),
  },
  {
    id: '06-in-addition-warnings-error', title: 'real In addition warnings plus error reconstructs all diagnostics',
    scenario: { id: '06-in-addition-warnings-error', steps: [{ label: 'in-addition', code: "{ warning('S1_IN_ADDITION_WARNING_A', call. = FALSE); warning('S1_IN_ADDITION_WARNING_B', call. = FALSE); stop('S1_IN_ADDITION_ERROR') }", expect: { status: 'error', warnings: ['S1_IN_ADDITION_WARNING_A', 'S1_IN_ADDITION_WARNING_B'], error: 'S1_IN_ADDITION_ERROR' } }] },
    expectedCodes: ["{ warning('S1_IN_ADDITION_WARNING_A', call. = FALSE); warning('S1_IN_ADDITION_WARNING_B', call. = FALSE); stop('S1_IN_ADDITION_ERROR') }"],
    verify: ({ runs }) => { expect(runs[0].debug.warnings).toHaveLength(2); expect(JSON.stringify(runs[0].result)).toContain('In addition:'); },
  },
  {
    id: '07-multiline-stateful-correction', title: 'multiline warning error then feedback-derived stateful correction',
    scenario: { id: '07-multiline-stateful-correction', steps: [
      { label: 'multiline-error', code: initialWarningThenError, expect: { status: 'error', warnings: ['S1_MULTILINE_WARNING'], error: 'S1_MULTILINE_ERROR=40' } },
      { label: 'multiline-correction', derive: { tag: 'S1_MULTILINE_ERROR', prefix: "{ rai_s1_fixed <- ", suffix: "; cat(sprintf('S1_MULTILINE_FIXED=%d\\n', rai_s1_fixed + 2L)) }" }, expect: { status: 'ok', stdout: 'S1_MULTILINE_FIXED=42' } },
    ] },
    expectedCodes: [initialWarningThenError, "{ rai_s1_fixed <- 40; cat(sprintf('S1_MULTILINE_FIXED=%d\\n', rai_s1_fixed + 2L)) }"],
    verify: ({ planning }) => expect(planning[0]).toMatchObject({ label: 'multiline-correction', feedback: expect.stringContaining('S1_MULTILINE_ERROR=40') }),
  },
  {
    id: '08-dataframe-subscript-correction', title: 'data-frame subscript error gets a separately approved correction',
    scenario: { id: '08-dataframe-subscript-correction', steps: [
      { label: 'dataframe-error', code: dataframeError, expect: { status: 'error', error: 'subscript' } },
      { label: 'dataframe-correction', code: "{ rai_s1_df[['value']][2] }", expect: { status: 'ok', stdout: '[1] 2' } },
    ] },
    expectedCodes: [dataframeError, "{ rai_s1_df[['value']][2] }"],
    verify: ({ runs }) => expect(runs[1].result).toMatchObject({ status: 'ok', stdout: expect.stringContaining('[1] 2') }),
  },
  {
    id: '09-nested-user-function', title: 'nested user-function error and call text are diagnostic',
    scenario: { id: '09-nested-user-function', steps: [{ label: 'nested-function', code: "{ rai_s1_inner <- function(x) stop(sprintf('S1_NESTED_ERROR=%s', x)); rai_s1_outer <- function() rai_s1_inner('deep'); rai_s1_outer() }", expect: { status: 'error', error: 'S1_NESTED_ERROR=deep' } }] },
    expectedCodes: ["{ rai_s1_inner <- function(x) stop(sprintf('S1_NESTED_ERROR=%s', x)); rai_s1_outer <- function() rai_s1_inner('deep'); rai_s1_outer() }"],
    verify: ({ runs }) => expect(JSON.stringify(runs[0].debug)).toContain('S1_NESTED_ERROR=deep'),
  },
  {
    id: '10-long-bounded-output-error', title: 'long bounded output and subsequent error remain structured',
    scenario: { id: '10-long-bounded-output-error', steps: [{ label: 'long-output-error', code: "{ for (i in 1:40) cat(sprintf('S1_LONG_%02d\\n', i)); stop('S1_LONG_ERROR') }", expect: { status: 'error', stdout: 'S1_LONG_40', error: 'S1_LONG_ERROR' } }] },
    expectedCodes: ["{ for (i in 1:40) cat(sprintf('S1_LONG_%02d\\n', i)); stop('S1_LONG_ERROR') }"],
    verify: ({ runs }) => { expect(JSON.stringify(runs[0].result)).toContain('S1_LONG_40'); expect(JSON.stringify(runs[0].debug)).toContain('S1_LONG_ERROR'); },
  },
  {
    id: '11-sequential-error-debug-correction-debug', title: 'one session holds error debug then feedback-derived correction debug',
    scenario: { id: '11-sequential-error-debug-correction-debug', steps: [
      { label: 'sequence-error', code: "{ rai_s1_sequence <- 41L; stop('S1_SEQUENCE_ERROR=41') }", expect: { status: 'error', error: 'S1_SEQUENCE_ERROR=41' } },
      { label: 'sequence-correction', derive: { tag: 'S1_SEQUENCE_ERROR', prefix: "{ rai_s1_sequence_fixed <- ", suffix: "; cat(sprintf('S1_SEQUENCE_FIXED=%d\\n', rai_s1_sequence_fixed + 1L)) }" }, expect: { status: 'ok', stdout: 'S1_SEQUENCE_FIXED=42' } },
    ] },
    expectedCodes: ["{ rai_s1_sequence <- 41L; stop('S1_SEQUENCE_ERROR=41') }", "{ rai_s1_sequence_fixed <- 41; cat(sprintf('S1_SEQUENCE_FIXED=%d\\n', rai_s1_sequence_fixed + 1L)) }"],
    verify: ({ runs, planning }) => { expect(runs).toHaveLength(2); expect(runs.map((run) => run.debug.status)).toEqual(['error', 'ok']); expect(planning[0].feedback).toContain('S1_SEQUENCE_ERROR=41'); },
  },
  {
    id: '12-invalid-run-id-read-only', title: 'unknown expired and malformed run ids reject read-only with zero Console input',
    scenario: { id: '12-invalid-run-id-read-only', debugOnlyIds: ['run-does-not-exist', 'run-expired-0000', 42] },
    expectedCodes: [],
    verify: ({ transcript }) => { const calls = transcript.filter((entry) => entry.tool === 'get_debug_info'); expect(calls).toHaveLength(3); for (const call of calls) { expect(['error', 'unknown']).toContain(call.result.status); expect(JSON.stringify(call.result)).not.toMatch(/S1_|stdout|warnings/i); } },
  },
];

function readEvidence(file: string): Evidence | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as Evidence : null;
}
function unprompt(text: string): string { return text.replace(/(^|\n)[>+] ?/g, '$1'); }
function count(text: string, needle: string): number { return text.split(needle).length - 1; }

for (const matrixCase of cases) {
  test(`Stage 1 packaged debugging matrix [${matrixCase.id}]: ${matrixCase.title}`, async ({ rstudioPage: page }) => {
    test.setTimeout(180000);
    const raiTest = await setupScriptedRaiTest(`stage1-${matrixCase.id}`, 'fake-claude-provider-stage1-debugging-matrix.mjs', {}, matrixCase.scenario);
    try {
      await page.evaluate((projectFile) => { (window as any).rstudio.project.open(projectFile); }, raiTest.projectFile);
      // Project switches restart R. Under a long packaged matrix the target
      // project can be visible before its deferred-init readiness signal settles;
      // retain both safety conditions with a full session-start window.
      await page.waitForFunction(({ projectPath }) => (window as any).rstudio?.ready === true && (window as any).rstudio?.project?.path?.() === projectPath, { projectPath: raiTest.projectPath }, { timeout: 60000 });
      const consoleActions = new ConsolePaneActions(page);
      await consoleActions.clearConsole();
      const baseline = await consoleActions.consolePane.consoleOutput.innerText();
      const promptsBefore = await page.evaluate(() => (window as any).rstudio.console.promptCount as number);
      await executeCommand(page, 'activateChat');
      await expect(page.locator("iframe[title='RAI Assistant']")).toBeVisible({ timeout: 15000 });
      await expect.poll(() => getChatState(page), { timeout: 60000, intervals: [1000] }).toBe('ready');
      const approval = page.locator('.rai-approval-card');
      const evidenceFile = path.join(raiTest.stateDir, 'stage1-evidence.json');
      // Valid run_r is admitted by the fixed native policy without a card.
      // The card remains the signal that a proposal was held for a click.
      await expect(approval).toHaveCount(0);
      if (matrixCase.expectedCodes.length > 0) {
        await expect.poll(() => readEvidence(evidenceFile)?.runs.length ?? 0, { timeout: 60000, intervals: [500] }).toBe(matrixCase.expectedCodes.length);
        await expect(approval).toHaveCount(0);
      }
      await expect.poll(() => readEvidence(evidenceFile), { timeout: 60000, intervals: [500] }).not.toBeNull();
      const evidence = readEvidence(evidenceFile)!;
      expect(evidence.runs).toHaveLength(matrixCase.expectedCodes.length);
      for (let i = 0; i < evidence.runs.length; i++) {
        const run = evidence.runs[i];
        expect(run.proposal).toEqual(R(matrixCase.expectedCodes[i]));
        expect(run.run_id).toMatch(/^run-[A-Za-z0-9-]+$/);
        const expected = matrixCase.scenario.steps![i].expect;
        expect(run.result.status).toBe(expected.status);
        if (expected.stdout) expect(JSON.stringify(run.result)).toContain(expected.stdout);
        if (expected.error) expect(JSON.stringify(run.debug)).toContain(expected.error);
        if (expected.warnings) {
          expect(run.debug.warnings).toHaveLength(expected.warnings.length);
          for (const warning of expected.warnings) expect(JSON.stringify(run.debug.warnings)).toContain(warning);
        }
        expect(run.debug.run_id).toBe(run.run_id);
      }
      matrixCase.verify(evidence);
      const debugCalls = evidence.transcript.filter((entry) => entry.tool === 'get_debug_info');
      expect(debugCalls).toHaveLength(matrixCase.expectedCodes.length || 3);
      for (const call of debugCalls) expect(Object.keys(call.arguments)).toEqual(['run_id']);
      expect(evidence.transcript.filter((entry) => entry.tool === 'run_r' && entry.result.status !== 'approval_required')).toHaveLength(matrixCase.expectedCodes.length);
      const consoleText = await consoleActions.consolePane.consoleOutput.innerText();
      const rawConsole = unprompt(consoleText);
      for (const code of matrixCase.expectedCodes) expect(count(rawConsole, code)).toBe(1);
      expect(consoleText).not.toContain('.rs.rai.consoleRun');
      expect(consoleText).not.toContain('get_debug_info');
      await expect.poll(() => page.evaluate(() => (window as any).rstudio.console.promptCount as number), { timeout: 15000, intervals: [100] }).toBe(promptsBefore + matrixCase.expectedCodes.length);
      if (matrixCase.expectedCodes.length === 0) expect(consoleText).toBe(baseline);
    } finally {
      await teardownScriptedRaiTest(page, raiTest.stateDir);
    }
  });
}

