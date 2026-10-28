// Editor behaviors ported from src/cpp/tests/automation/testthat/test-automation-editor.R.

import { test, expect } from '@fixtures/rstudio.fixture';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { AceEditor } from '@pages/ace_editor.page';
import { useSuiteSandbox } from '@utils/sandbox';
import { writeAndOpenFile, closeAndDeleteSandboxFiles } from '@utils/files';
import { clearPref, executeCommand, saveDocument, setPref, waitForActiveDocument } from '@utils/commands';
import { TIMEOUTS } from '@utils/constants';

// Every open document retains a FindReplaceBar in the DOM, including hidden
// inactive editors. Accessible role queries inside the Source region select
// only the active bar; the Console's separate Find bar cannot match.
const sourceFindBar = (page: import('@playwright/test').Page) => {
  const source = page.getByRole('region', { name: 'Source' });
  return {
    find: source.getByRole('textbox', { name: 'Find', exact: true }),
    replace: source.getByRole('textbox', { name: 'Replace', exact: true }),
    wholeWord: source.getByRole('checkbox', { name: 'Whole word', exact: true }),
    replaceButton: source.getByRole('button', { name: 'Replace', exact: true }),
    close: source.getByRole('button', { name: 'Close find and replace', exact: true }),
  };
};

test.describe('Editor', () => {
  const sandbox = useSuiteSandbox();
  let consoleActions: ConsolePaneActions;

  test.beforeAll(async ({ rstudioPage: page }) => {
    consoleActions = new ConsolePaneActions(page);
    await consoleActions.resetSourcePane();
  });

  test.afterEach(async ({ rstudioPage: page }) => {
    await closeAndDeleteSandboxFiles(page, sandbox.dir, [
      'editor_whitespace.R',
      'editor_whole_word.R',
      'editor_hidden_find.R',
      'editor_active_find.R',
      'editor_shortcuts.R',
      'editor_find_from_selection.R',
      'editor_comment_indent.R',
    ]);
  });

  test('trailing whitespace is trimmed on save when pref is enabled', async ({ rstudioPage: page }) => {
    // setPref goes through the bridge (synchronous to GWT) -- using
    // executeInConsole here would race the save below, since the R-side
    // pref update isn't necessarily visible to the editor's save flow yet.
    await setPref(page, 'strip_trailing_whitespace', true);
    try {
      const content = '# comment 1  \n# comment 2 \n# comment 3   \n';
      await writeAndOpenFile(page, sandbox.dir, 'editor_whitespace.R', content);

      const editor = new AceEditor(page, '# comment 1');
      await expect.poll(() => editor.getValue()).toContain('# comment 3');

      await editor.gotoLine(4);
      await editor.insert('# comment 4   ');

      await saveDocument(page);

      expect((await editor.getValue()).trim()).toBe('# comment 1\n# comment 2\n# comment 3\n# comment 4');
    } finally {
      await clearPref(page, 'strip_trailing_whitespace');
    }
  });

  // Deterministic regression: an inactive document retains its hidden find
  // control in the DOM. The active source's Find textbox must be unique.
  test('active editor find ignores an inactive document find bar', async ({ rstudioPage: page }) => {
    await writeAndOpenFile(page, sandbox.dir, 'editor_hidden_find.R', 'x <- 1\n');
    await executeCommand(page, 'findReplace');
    await expect(page.getByRole('region', { name: 'Source' }).getByRole('textbox', { name: 'Find', exact: true })).toBeVisible();
    await writeAndOpenFile(page, sandbox.dir, 'editor_active_find.R', 'y <- 2\n');
    await waitForActiveDocument(page, `${sandbox.dir}/editor_active_find.R`, TIMEOUTS.fileOpen);
    await executeCommand(page, 'findReplace');
    const find = sourceFindBar(page).find;
    await expect(find).toHaveCount(1);
    await expect(find).toBeVisible();
  });

  // https://github.com/rstudio/rstudio/issues/16798
  test('whole-word find and replace handles leading dots correctly', async ({ rstudioPage: page }) => {
    const content = '.hello\n.hello\n.hello';
    await writeAndOpenFile(page, sandbox.dir, 'editor_whole_word.R', content);

    const editor = new AceEditor(page, '.hello');
    await expect.poll(() => editor.getValue()).toContain('.hello');

    // Invoke findReplace through the automation bridge -- the command targets
    // the active source editor without needing keyboard focus there. Wait for
    // the just-opened document to be reported as the active source target;
    // on Server, the editor needs a beat after the tab renders before it
    // registers as the find-replace target.
    await waitForActiveDocument(page, `${sandbox.dir}/editor_whole_word.R`, TIMEOUTS.fileOpen);
    await executeCommand(page, 'findReplace');
    const findBar = sourceFindBar(page);
    await expect(findBar.find).toHaveCount(1);
    await expect(findBar.find).toBeVisible({ timeout: TIMEOUTS.consoleReady });

    await findBar.wholeWord.click();

    await findBar.find.click();
    await findBar.find.pressSequentially('.hello');

    await findBar.replace.click();
    await findBar.replace.pressSequentially('.goodbye');

    // "Replace" replaces the current match and advances. With find-as-you-type
    // the first match is already current after typing the search term, so no
    // explicit Find Next click is needed -- it would skip past the first match
    // before any replacement happens.
    await findBar.replaceButton.click();
    await findBar.replaceButton.click();

    // Restore checkbox state and close the find bar so it doesn't bleed into later tests.
    await findBar.wholeWord.click();
    await findBar.close.click();
    await expect(findBar.find).toHaveCount(0, { timeout: 5000 });

    await expect.poll(() => editor.getValue()).toBe('.goodbye\n.goodbye\n.hello');
  });

  // https://github.com/rstudio/rstudio/issues/16973
  test('AceEditorCommandDispatcher shortcuts work', async ({ rstudioPage: page }) => {
    // Use distinct content markers (xxshort/yyshort) so the AceEditor wrapper
    // can locate this editor regardless of newline normalization quirks.
    const content = 'xxshort\nyyshort\n';
    await writeAndOpenFile(page, sandbox.dir, 'editor_shortcuts.R', content);

    const editor = new AceEditor(page, 'xxshort');
    await expect.poll(() => editor.getValue()).toContain('xxshort');

    // Insert pipe operator (|> or %>%) at end of line 1.
    await editor.gotoLine(1);
    await editor.navigateLineEnd();
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+Shift+m');

    await expect.poll(() => editor.getValue()).toMatch(/\|>|%>%/);

    // Insert assignment operator at end of line 2.
    await editor.gotoLine(2);
    await editor.navigateLineEnd();
    await editor.focus();
    await page.keyboard.press('Alt+-');

    await expect.poll(() => editor.getValue()).toContain('<-');
  });

  // https://github.com/rstudio/rstudio/issues/15863
  test('findFromSelection does not jump to next instance on first invocation', async ({ rstudioPage: page }) => {
    const content = 'hello world\nhello world\nhello world\n';
    await writeAndOpenFile(page, sandbox.dir, 'editor_find_from_selection.R', content);

    const editor = new AceEditor(page, 'hello world');
    await expect.poll(() => editor.getValue()).toContain('hello world');

    // Move to line 1 and select the first "hello".
    await editor.gotoLine(1);
    await editor.find('hello');

    const posBefore = await editor.getCursorPosition();

    // First invocation should set the search term without advancing the cursor.
    // Wait for the find bar to open before reading the cursor -- otherwise we
    // can sample the position before the command's selection-to-find handler
    // has run, masking a regression where the cursor *does* advance.
    await executeCommand(page, 'findFromSelection');
    const findBar = sourceFindBar(page);
    await expect(findBar.find).toHaveCount(1);
    await expect(findBar.find).toBeVisible({ timeout: 5000 });

    const posAfter = await editor.getCursorPosition();
    expect(posAfter.row).toBe(posBefore.row);

    // Second invocation advances to the next match.
    await executeCommand(page, 'findFromSelection');
    await expect.poll(async () => (await editor.getCursorPosition()).row).toBeGreaterThan(posBefore.row);

    // Close the find bar via its dedicated button so we don't depend on
    // keyboard focus being on the bar.
    await findBar.close.click();
    await expect(findBar.find).toHaveCount(0, { timeout: 5000 });
  });

  // https://github.com/rstudio/rstudio/issues/17493
  test('comment shortcut preserves indent on an empty indented line', async ({ rstudioPage: page }) => {
    const content = 'f <- function() {\n\n}\n';
    await writeAndOpenFile(page, sandbox.dir, 'editor_comment_indent.R', content);

    const editor = new AceEditor(page, 'f <- function()');
    await expect.poll(() => editor.getValue()).toContain('f <- function()');

    // Put the cursor on the empty body line and indent it, mirroring the user
    // pressing Tab on a fresh line inside the function. gotoLine(2) and
    // getLine(1) below both target this line (1-indexed vs 0-indexed).
    await editor.gotoLine(2);
    await editor.insert('  ');

    await executeCommand(page, 'commentUncomment');

    // The comment character must land after the indent, not at column zero.
    await expect.poll(() => editor.getLine(1)).toMatch(/^  #/);
  });
});
