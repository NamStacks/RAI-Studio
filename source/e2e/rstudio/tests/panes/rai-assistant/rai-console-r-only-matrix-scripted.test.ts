import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import { executeCommand, getChatState } from '@utils/commands';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

type Proposal = {
  language: string;
  target: string;
  code: string;
};

type Scenario = {
  proposals: Proposal[];
};

type RecordedResult = {
  proposal: Proposal;
  result: Record<string, unknown>;
};

const R = (code: string): Proposal => ({ language: 'R', target: 'console', code });
const INVALID = (language: string, code: string): Proposal => ({ language, target: 'console', code });

const cases: Array<{
  id: string;
  name: string;
  scenario: Scenario;
  approvals: string[];
  verify: (results: RecordedResult[], consoleText: string) => void;
}> = [
  {
    id: 'arithmetic',
    name: 'arithmetic reaches the Console only after its own approval',
    scenario: { proposals: [R('20 + 22')] },
    approvals: ['20 + 22'],
    verify: (results, consoleText) => {
      expect(results).toHaveLength(1);
      expect(results[0].result).toMatchObject({ status: 'ok', stdout: expect.stringContaining('[1] 42') });
      expect(consoleText).toContain('[1] 42');
    },
  },
  {
    id: 'state-assignment-readback',
    name: 'state assignment and readback execute as one approved R expression',
    scenario: { proposals: [R('{ rai_matrix_value <- 41L\nrai_matrix_value + 1L\n}')] },
    approvals: ['{ rai_matrix_value <- 41L\nrai_matrix_value + 1L\n}'],
    verify: (results, consoleText) => {
      expect(results).toHaveLength(1);
      expect(results[0].result).toMatchObject({ status: 'ok', stdout: expect.stringContaining('[1] 42') });
      expect(consoleText).toContain('rai_matrix_value + 1L');
    },
  },
  {
    id: 'data-frame-result',
    name: 'a data frame result is returned by the approved Console run',
    scenario: { proposals: [R("data.frame(id = 1:2, label = c('alpha', 'beta'))")] },
    approvals: ["data.frame(id = 1:2, label = c('alpha', 'beta'))"],
    verify: (results, consoleText) => {
      expect(results).toHaveLength(1);
      expect(results[0].result).toMatchObject({ status: 'ok', stdout: expect.stringContaining('alpha') });
      expect(consoleText).toContain('beta');
    },
  },
  {
    id: 'function-definition-call',
    name: 'a function definition and call execute through one approved R expression',
    scenario: { proposals: [R('{ rai_matrix_double <- function(x) x * 2\nrai_matrix_double(21)\n}')] },
    approvals: ['{ rai_matrix_double <- function(x) x * 2\nrai_matrix_double(21)\n}'],
    verify: (results, consoleText) => {
      expect(results).toHaveLength(1);
      expect(results[0].result).toMatchObject({ status: 'ok', stdout: expect.stringContaining('[1] 42') });
      expect(consoleText).toContain('rai_matrix_double(21)');
    },
  },
  {
    id: 'multiline-braced-expression',
    name: 'a multiline single braced expression is accepted and executed',
    scenario: { proposals: [R("{\n  left <- 19L\n  right <- 23L\n  cat(sprintf('MULTILINE_TOTAL=%d\\n', left + right))\n}")] },
    approvals: ["{\n  left <- 19L\n  right <- 23L\n  cat(sprintf('MULTILINE_TOTAL=%d\\n', left + right))\n}"],
    verify: (results, consoleText) => {
      expect(results).toHaveLength(1);
      expect(results[0].result).toMatchObject({ status: 'ok', stdout: expect.stringContaining('MULTILINE_TOTAL=42') });
      expect(consoleText).toContain('MULTILINE_TOTAL=42');
    },
  },
  {
    id: 'message-warning-capture',
    name: 'messages and warnings from an approved R run are captured',
    scenario: { proposals: [R("{ message('RAI_MATRIX_MESSAGE'); warning('RAI_MATRIX_WARNING'); cat('RAI_MATRIX_DONE\\n') }")] },
    approvals: ["{ message('RAI_MATRIX_MESSAGE'); warning('RAI_MATRIX_WARNING'); cat('RAI_MATRIX_DONE\\n') }"],
    verify: (results, consoleText) => {
      expect(results).toHaveLength(1);
      expect(results[0].result).toMatchObject({ status: 'ok' });
      expect(String(results[0].result.condition_state)).toBe('non_error');
      expect(String(results[0].result.completion)).toBe('top_level_prompt');
      expect(JSON.stringify(results[0].result)).toContain('RAI_MATRIX_MESSAGE');
      expect(JSON.stringify(results[0].result)).toContain('RAI_MATRIX_WARNING');
      expect(consoleText).toContain('RAI_MATRIX_DONE');
    },
  },
  {
    id: 'runtime-error-correction',
    name: 'a runtime error settles before a separately approved correction runs',
    scenario: { proposals: [R("stop('RAI_MATRIX_RUNTIME_ERROR')"), R("cat('RAI_MATRIX_CORRECTED=42\\n')")] },
    approvals: ["stop('RAI_MATRIX_RUNTIME_ERROR')", "cat('RAI_MATRIX_CORRECTED=42\\n')"],
    verify: (results, consoleText) => {
      expect(results).toHaveLength(2);
      expect(results[0].result).toMatchObject({ status: 'error' });
      expect(JSON.stringify(results[0].result)).toContain('RAI_MATRIX_RUNTIME_ERROR');
      expect(results[1].result).toMatchObject({ status: 'ok', stdout: expect.stringContaining('RAI_MATRIX_CORRECTED=42') });
      expect(consoleText).toContain('RAI_MATRIX_CORRECTED=42');
    },
  },
  {
    id: 'malformed-parse-rejection',
    name: 'malformed R is rejected before approval and adds no Console input',
    scenario: { proposals: [R('if (')] },
    approvals: [],
    verify: (results, consoleText) => {
      expect(results).toHaveLength(1);
      expect(results[0].result).toMatchObject({ status: 'error' });
      expect(JSON.stringify(results[0].result)).toMatch(/parse|syntax|invalid|executable R code only/i);
      expect(consoleText).not.toContain('if (');
    },
  },
  {
    id: 'strict-r-only-rejection',
    name: 'non-R, Markdown, JSON, shell, and multi-statement inputs are rejected without Console input',
    scenario: {
      proposals: [
        INVALID('python', "print('RAI_MATRIX_NON_R')"),
        R('# RAI_MATRIX_MARKDOWN\n**not R**'),
        R('{"kind":"RAI_MATRIX_JSON"}'),
        R('#!/bin/sh\necho RAI_MATRIX_SHELL'),
        R("cat('RAI_MATRIX_FIRST\\n'); cat('RAI_MATRIX_SECOND\\n')"),
      ],
    },
    approvals: [],
    verify: (results, consoleText) => {
      expect(results).toHaveLength(5);
      for (const { result } of results) {
        expect(result).toMatchObject({ status: 'error' });
        expect(result).not.toHaveProperty('run_id');
      }
      expect(consoleText).not.toContain('RAI_MATRIX_');
    },
  },
  {
    id: 'stateful-correction-readback-loop',
    name: 'a separately approved stateful correction is visible to its approved readback',
    scenario: {
      proposals: [
        R('rai_matrix_loop_value <- 40L'),
        R('rai_matrix_loop_value <- rai_matrix_loop_value + 2L'),
        R("cat(sprintf('RAI_MATRIX_LOOP_VALUE=%d\\n', rai_matrix_loop_value))"),
      ],
    },
    approvals: [
      'rai_matrix_loop_value <- 40L',
      'rai_matrix_loop_value <- rai_matrix_loop_value + 2L',
      "cat(sprintf('RAI_MATRIX_LOOP_VALUE=%d\\n', rai_matrix_loop_value))",
    ],
    verify: (results, consoleText) => {
      expect(results).toHaveLength(3);
      expect(results.map(({ result }) => result.status)).toEqual(['ok', 'ok', 'ok']);
      expect(results[2].result).toMatchObject({ stdout: expect.stringContaining('RAI_MATRIX_LOOP_VALUE=42') });
      expect(consoleText).toContain('RAI_MATRIX_LOOP_VALUE=42');
    },
  },
];

async function openScriptedAssistant(page: Parameters<typeof teardownScriptedRaiTest>[0], projectFile: string, projectPath: string): Promise<ConsolePaneActions> {
  await page.evaluate((file) => { (window as any).rstudio.project.open(file); }, projectFile);
  await page.waitForFunction(
    ({ expectedProjectPath }) => (window as any).rstudio?.ready === true &&
      (window as any).rstudio?.project?.path?.() === expectedProjectPath,
    { expectedProjectPath: projectPath },
    { timeout: 60000 },
  );

  const consoleActions = new ConsolePaneActions(page);
  await consoleActions.clearConsole();
  await executeCommand(page, 'activateChat');
  await expect(page.locator("iframe[title='RAI Assistant']")).toBeVisible({ timeout: 15000 });
  await expect.poll(() => getChatState(page), { timeout: 60000, intervals: [1000] }).toBe('ready');
  return consoleActions;
}

for (const matrixCase of cases) {
  test(`R-only acceptance matrix: ${matrixCase.name}`, async ({ rstudioPage: page }) => {
    test.setTimeout(150000);
    const raiTest = await setupScriptedRaiTest(matrixCase.id, 'fake-claude-provider-matrix.mjs', {}, matrixCase.scenario);
    try {
      const consoleActions = await openScriptedAssistant(page, raiTest.projectFile, raiTest.projectPath);
      const baselineConsoleText = await consoleActions.consolePane.consoleOutput.innerText();
      const approvalCard = page.locator('.rai-approval-card');

      await expect(approvalCard).toHaveCount(0);

      const resultFile = path.join(raiTest.stateDir, 'results.json');
      await expect.poll(
        () => fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) as RecordedResult[] : [],
        { timeout: 30000, intervals: [500] },
      ).toHaveLength(matrixCase.scenario.proposals.length);
      const results = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as RecordedResult[];
      const consoleText = await consoleActions.consolePane.consoleOutput.innerText();
      matrixCase.verify(results, consoleText);
      expect(consoleText).not.toContain('.rs.rai.consoleRun');
      if (matrixCase.approvals.length === 0)
        expect(consoleText).toBe(baselineConsoleText);
    } finally {
      await teardownScriptedRaiTest(page, raiTest.stateDir);
    }
  });
}
