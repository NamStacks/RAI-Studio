import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import type { TestInfo } from '@playwright/test';
import { documentOpen, executeCommand, getChatState } from '@utils/commands';
import { AceEditor } from '@pages/ace_editor.page';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

const ORIGINAL = "threshold <- 0.05\nmessage('keep this line 😀')\n";
const READ_ONLY = "# do not edit by hand\nthreshold <- 0.05\n";
const EXPECTED = 'threshold <- 0.05';
const REPLACEMENT = 'threshold <- 0.01';

test.describe('RAI Assistant editor edit (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.beforeEach(async ({}, testInfo: TestInfo) => {
    const isReadOnly = testInfo.title.includes('read-only');
    const isIneligible = testInfo.title.includes('ineligible');
    const isStale = testInfo.title.includes('closed focused');
    const isChangedAfterProposal = testInfo.title.includes('content changed after the read');
    const isPutFailure = testInfo.title.includes('source database put failure');
    const isTraceFailure = testInfo.title.includes('final trace failure');
    raiTest = await setupScriptedRaiTest('editor-edit', 'fake-claude-provider-editor-edit.mjs',
      isIneligible ? { 'analysis.txt': 'not an eligible R source document\n' } : {
        'analysis.R': isReadOnly ? READ_ONLY : ORIGINAL,
      },
      isIneligible ? { mode: 'expect_inactive' } :
        isStale ? { mode: 'expect_inactive_after_signal' } :
          isChangedAfterProposal ? { mode: 'expect_stale_after_read' } :
            isPutFailure ? { mode: 'expect_put_failure' } :
              isTraceFailure ? { mode: 'expect_trace_failure' } :
                testInfo.title.includes('Full Auto') ? { mode: 'expect_full_auto' } : undefined,
      testInfo.title.includes('Full Auto') || isPutFailure || isTraceFailure,
    );
  });

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('an ineligible focused tab has no active document context', async ({ rstudioPage: page }) => {
    test.setTimeout(120000);
    await page.evaluate((projectFile) => (window as any).rstudio.project.open(projectFile), raiTest!.projectFile);
    await page.waitForFunction(
      ({ projectPath }) => (window as any).rstudio?.ready === true &&
        (window as any).rstudio?.project?.path?.() === projectPath,
      { projectPath: raiTest!.projectPath }, { timeout: 30000 },
    );
    await documentOpen(page, path.join(path.dirname(raiTest!.projectFile), 'analysis.txt'));
    await executeCommand(page, 'activateChat');
    await expect(page.locator("iframe[title='RAI Assistant']")).toBeVisible({ timeout: 15000 });
    await expect.poll(
      () => fs.existsSync(path.join(raiTest!.stateDir, 'result.json'))
        ? JSON.parse(fs.readFileSync(path.join(raiTest!.stateDir, 'result.json'), 'utf8')) : null,
      { timeout: 15000, intervals: [500] },
    ).toMatchObject({ status: 'inactive' });
  });

  test('a closed focused source tab has no stale active document context', async ({ rstudioPage: page }) => {
    test.setTimeout(120000);
    await page.evaluate((projectFile) => (window as any).rstudio.project.open(projectFile), raiTest!.projectFile);
    await page.waitForFunction(
      ({ projectPath }) => (window as any).rstudio?.ready === true &&
        (window as any).rstudio?.project?.path?.() === projectPath,
      { projectPath: raiTest!.projectPath }, { timeout: 30000 },
    );
    await documentOpen(page, path.join(path.dirname(raiTest!.projectFile), 'analysis.R'));
    await executeCommand(page, 'activateChat');
    await expect(page.locator("iframe[title='RAI Assistant']")).toBeVisible({ timeout: 15000 });
    await expect.poll(() => fs.existsSync(path.join(raiTest!.stateDir, 'provider-ready')), { timeout: 15000 }).toBe(true);
    await executeCommand(page, 'closeSourceDoc');
    await page.waitForFunction(() => (window as any).rstudio?.documents?.active?.() == null, undefined, { timeout: 15000 });
    fs.writeFileSync(path.join(raiTest!.stateDir, 'proceed'), 'go');
    await expect.poll(
      () => fs.existsSync(path.join(raiTest!.stateDir, 'result.json'))
        ? JSON.parse(fs.readFileSync(path.join(raiTest!.stateDir, 'result.json'), 'utf8')) : null,
      { timeout: 15000, intervals: [500] },
    ).toMatchObject({ status: 'inactive' });
  });

  test('content changed after the read is refused before any edit and the changed buffer is kept', async ({ rstudioPage: page }) => {
    test.setTimeout(120000);
    await page.evaluate((projectFile) => (window as any).rstudio.project.open(projectFile), raiTest!.projectFile);
    await page.waitForFunction(
      ({ projectPath }) => (window as any).rstudio?.ready === true &&
        (window as any).rstudio?.project?.path?.() === projectPath,
      { projectPath: raiTest!.projectPath }, { timeout: 30000 },
    );
    await documentOpen(page, path.join(path.dirname(raiTest!.projectFile), 'analysis.R'));
    await executeCommand(page, 'activateChat');
    await expect(page.locator("iframe[title='RAI Assistant']")).toBeVisible({ timeout: 15000 });
    await expect.poll(() => fs.existsSync(path.join(raiTest!.stateDir, 'proposal-ready')), { timeout: 15000 }).toBe(true);
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);
    const editor = new AceEditor(page, '');
    await page.getByRole('tabpanel', { name: 'analysis.R' }).locator('.ace_text-input').click({ force: true });
    await page.keyboard.press('Meta+A');
    await page.keyboard.type('threshold <- 0.02');
    await expect.poll(() => editor.getValue(), { timeout: 5000 }).toBe('threshold <- 0.02');
    await page.waitForTimeout(750);
    fs.writeFileSync(path.join(raiTest!.stateDir, 'buffer-changed'), 'done');
    await expect.poll(
      () => fs.existsSync(path.join(raiTest!.stateDir, 'result.json'))
        ? JSON.parse(fs.readFileSync(path.join(raiTest!.stateDir, 'result.json'), 'utf8')) : null,
      { timeout: 15000, intervals: [500] },
    ).toMatchObject({ status: 'stale' });
    await expect.poll(() => editor.getValue(), { timeout: 5000 }).toBe('threshold <- 0.02');
  });

  test('read-only open documents are reported truthfully and never queue an edit approval', async ({ rstudioPage: page }) => {
    test.setTimeout(120000);
    await page.evaluate((projectFile) => (window as any).rstudio.project.open(projectFile), raiTest!.projectFile);
    await page.waitForFunction(
      ({ projectPath }) => (window as any).rstudio?.ready === true &&
        (window as any).rstudio?.project?.path?.() === projectPath,
      { projectPath: raiTest!.projectPath }, { timeout: 30000 },
    );
    await documentOpen(page, path.join(path.dirname(raiTest!.projectFile), 'analysis.R'));
    const editor = new AceEditor(page, '');
    await expect.poll(() => editor.getValue(), { timeout: 15000 }).toBe(READ_ONLY);

    await executeCommand(page, 'activateChat');
    await expect(page.locator("iframe[title='RAI Assistant']")).toBeVisible({ timeout: 15000 });
    await expect.poll(() => getChatState(page), { timeout: 60000, intervals: [1000] }).toBe('ready');
    await expect.poll(
      () => fs.existsSync(path.join(raiTest!.stateDir, 'result.json'))
        ? JSON.parse(fs.readFileSync(path.join(raiTest!.stateDir, 'result.json'), 'utf8')) : null,
      { timeout: 15000, intervals: [500] },
    ).toMatchObject({ status: 'rejected', read_only: true });
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);
    await expect.poll(() => editor.getValue(), { timeout: 5000 }).toBe(READ_ONLY);
  });

  test('exact replacement is applied and saved without an approval card', async ({ rstudioPage: page }) => {
    test.setTimeout(120000);
    await page.evaluate((projectFile) => (window as any).rstudio.project.open(projectFile), raiTest!.projectFile);
    await page.waitForFunction(
      ({ projectPath }) => (window as any).rstudio?.ready === true &&
        (window as any).rstudio?.project?.path?.() === projectPath,
      { projectPath: raiTest!.projectPath }, { timeout: 30000 },
    );

    const analysisPath = path.join(path.dirname(raiTest!.projectFile), 'analysis.R');
    await documentOpen(page, analysisPath);
    const editor = new AceEditor(page, '');
    await expect.poll(() => editor.getValue(), { timeout: 15000 }).toBe(ORIGINAL);

    await executeCommand(page, 'activateChat');
    await expect(page.locator("iframe[title='RAI Assistant']")).toBeVisible({ timeout: 15000 });
    await expect.poll(() => getChatState(page), { timeout: 60000, intervals: [1000] }).toBe('ready');

    await expect(page.locator('.rai-approval-card')).toHaveCount(0);
    await expect.poll(() => editor.getValue(), { timeout: 30000 }).toBe(
      "threshold <- 0.01\nmessage('keep this line 😀')\n",
    );
    await expect.poll(
      () => fs.existsSync(path.join(raiTest!.stateDir, 'result.json'))
        ? JSON.parse(fs.readFileSync(path.join(raiTest!.stateDir, 'result.json'), 'utf8')) : null,
      { timeout: 15000, intervals: [500] },
    ).toMatchObject({ status: 'applied', expected_text: EXPECTED, replacement: REPLACEMENT });
    // RAI saving is always on, so the applied buffer is saved.
    expect(fs.readFileSync(analysisPath, 'utf8')).toBe(
      "threshold <- 0.01\nmessage('keep this line 😀')\n",
    );
  });

  test('Full Auto applies the exact replacement with no approval card and Undo restores the original', async ({ rstudioPage: page }) => {
    test.setTimeout(120000);
    await page.evaluate((projectFile) => (window as any).rstudio.project.open(projectFile), raiTest!.projectFile);
    await page.waitForFunction(
      ({ projectPath }) => (window as any).rstudio?.ready === true &&
        (window as any).rstudio?.project?.path?.() === projectPath,
      { projectPath: raiTest!.projectPath }, { timeout: 30000 },
    );

    const analysisPath = path.join(path.dirname(raiTest!.projectFile), 'analysis.R');
    const diskBefore = fs.readFileSync(analysisPath, 'utf8');
    await documentOpen(page, analysisPath);
    const editor = new AceEditor(page, '');
    await expect.poll(() => editor.getValue(), { timeout: 15000 }).toBe(ORIGINAL);

    await executeCommand(page, 'activateChat');
    await expect(page.locator("iframe[title='RAI Assistant']")).toBeVisible({ timeout: 15000 });
    await expect.poll(() => getChatState(page), { timeout: 60000, intervals: [1000] }).toBe('ready');

    await expect.poll(() => editor.getValue(), { timeout: 30000 }).toBe(
      "threshold <- 0.01\nmessage('keep this line 😀')\n",
    );
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);
    await expect.poll(
      () => fs.existsSync(path.join(raiTest!.stateDir, 'result.json'))
        ? JSON.parse(fs.readFileSync(path.join(raiTest!.stateDir, 'result.json'), 'utf8')) : null,
      { timeout: 15000, intervals: [500] },
    ).toMatchObject({ status: 'applied', approval: 'autonomous', buffer_has_replacement: true });
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);
    // RAI saving is always on, so the applied buffer is saved.
    expect(fs.readFileSync(analysisPath, 'utf8')).toBe(
      "threshold <- 0.01\nmessage('keep this line 😀')\n",
    );
    expect(diskBefore).toBe(ORIGINAL);

    // The native replace_ranges edit is one editor Undo step.
    await page.getByRole('tabpanel', { name: 'analysis.R' }).locator('.ace_text-input').click({ force: true });
    await page.keyboard.press('Meta+Z');
    await expect.poll(() => editor.getValue(), { timeout: 5000 }).toBe(ORIGINAL);
  });

  test('source database put failure restores the original open buffer without an editor event', async ({ rstudioPage: page }) => {
    test.setTimeout(120000);
    await page.evaluate((projectFile) => (window as any).rstudio.project.open(projectFile), raiTest!.projectFile);
    await page.waitForFunction(
      ({ projectPath }) => (window as any).rstudio?.ready === true &&
        (window as any).rstudio?.project?.path?.() === projectPath,
      { projectPath: raiTest!.projectPath }, { timeout: 30000 },
    );
    const analysisPath = path.join(path.dirname(raiTest!.projectFile), 'analysis.R');
    await documentOpen(page, analysisPath);
    const editor = new AceEditor(page, '');
    await expect.poll(() => editor.getValue(), { timeout: 15000 }).toBe(ORIGINAL);
    await executeCommand(page, 'activateChat');
    const ready = path.join(raiTest!.stateDir, 'provider-ready');
    await expect.poll(() => fs.existsSync(ready), { timeout: 30000 }).toBe(true);
    const documentId = fs.readFileSync(ready, 'utf8');
    const sandbox = process.env.PW_SANDBOX;
    expect(sandbox).toBeTruthy();
    const contents = fs.readdirSync(sandbox!, { recursive: true }).map(String)
      .filter(rel => path.basename(rel) === `${documentId}-contents`);
    expect(contents, 'exact isolated source-database sidecar').toHaveLength(1);
    const contentsPath = path.join(sandbox!, contents[0]);
    const originalMode = fs.statSync(contentsPath).mode & 0o777;
    // SourceDatabase::put opens the existing -contents sidecar O_WRONLY|O_TRUNC;
    // a read-only parent directory does not prevent that open on macOS.
    fs.chmodSync(contentsPath, 0o400);
    try {
      expect(() => fs.accessSync(contentsPath, fs.constants.W_OK)).toThrow();
      fs.writeFileSync(path.join(raiTest!.stateDir, 'proceed'), 'go');
      await expect.poll(() => fs.existsSync(path.join(raiTest!.stateDir, 'result.json'))
        ? JSON.parse(fs.readFileSync(path.join(raiTest!.stateDir, 'result.json'), 'utf8')) : null,
        { timeout: 30000, intervals: [500] },
      ).toMatchObject({ status: 'error', buffer_unchanged: true, trace_seq: null });
      await expect.poll(() => editor.getValue(), { timeout: 5000 }).toBe(ORIGINAL);
      await expect(page.locator('.rai-approval-card')).toHaveCount(0);
      expect(fs.readFileSync(analysisPath, 'utf8')).toBe(ORIGINAL);
    } finally {
      fs.chmodSync(contentsPath, originalMode);
    }
  });

  test('final trace failure rolls back the exact native edit before exposing it to the IDE', async ({ rstudioPage: page }) => {
    test.setTimeout(120000);
    await page.evaluate((projectFile) => (window as any).rstudio.project.open(projectFile), raiTest!.projectFile);
    await page.waitForFunction(
      ({ projectPath }) => (window as any).rstudio?.ready === true &&
        (window as any).rstudio?.project?.path?.() === projectPath,
      { projectPath: raiTest!.projectPath }, { timeout: 30000 },
    );
    const analysisPath = path.join(path.dirname(raiTest!.projectFile), 'analysis.R');
    await documentOpen(page, analysisPath);
    const editor = new AceEditor(page, '');
    await expect.poll(() => editor.getValue(), { timeout: 15000 }).toBe(ORIGINAL);
    const consoleActions = new ConsolePaneActions(page);
    await consoleActions.executeInConsole(
      "local({ e <- environment(get('.rs.rai.completeDocumentEdit', envir = .rs.toolsEnv(), inherits = FALSE)); stopifnot(exists('.rs.rai.appendTrace', envir = e, inherits = FALSE)); old <- get('.rs.rai.appendTrace', envir = e, inherits = FALSE); assign('.rs.rai.appendTrace', function(event, fields = list()) if (identical(event, 'edit_applied')) NULL else old(event, fields), envir = e); stopifnot(!identical(get('.rs.rai.appendTrace', envir = e), old)) })",
      { wait: true },
    );
    await executeCommand(page, 'activateChat');
    await expect.poll(() => fs.existsSync(path.join(raiTest!.stateDir, 'result.json'))
      ? JSON.parse(fs.readFileSync(path.join(raiTest!.stateDir, 'result.json'), 'utf8')) : null,
      { timeout: 30000, intervals: [500] },
    ).toMatchObject({ status: 'error', buffer_unchanged: true, trace_seq: null });
    await expect.poll(() => editor.getValue(), { timeout: 5000 }).toBe(ORIGINAL);
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);
    expect(fs.readFileSync(analysisPath, 'utf8')).toBe(ORIGINAL);
  });
});
