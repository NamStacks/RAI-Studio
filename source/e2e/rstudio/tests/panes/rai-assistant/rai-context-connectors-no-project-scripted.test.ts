import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import type { Page } from 'playwright';
import { executeCommand, getChatState } from '@utils/commands';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

// get_project_context takes no path argument, so its root is whatever the
// session already has open. That made "no project open" the dangerous case
// rather than the harmless one: the root used to fall back to the session's
// working directory, which on a fresh desktop session is the user's home
// directory, so this read-only call -- which raises no approval card -- shipped
// a two-level listing of $HOME, and the account name via root_name, to the
// provider.
//
// This lives in its own spec file on purpose. Tests inside a file share one
// RStudio session, and rai-context-connectors-scripted.test.ts opens a project
// in it; a "no project" assertion sharing that session would depend on
// declaration order and would silently start passing for the wrong reason the
// moment the order changed. A separate file gets a session that has never had a
// project opened.
//
// Native-side coverage of the same decision, with a negative control, is in
// SessionRaiAssistantTests.cpp (ProjectContextWithoutAnActiveProjectWalksNothing).

type ManifestEntry = { path: string; kind: string; size_bytes: number };

type ToolEntry = {
  method?: string;
  tool?: string;
  arguments?: unknown;
  response?: unknown;
};

type ContextConnectorsData = {
  project_result: {
    project_active: boolean;
    root_name: string | null;
    working_directory: string | null;
  };
  transcript: ToolEntry[];
};

function readData(file: string): ContextConnectorsData | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as ContextConnectorsData : null;
}

async function openAssistant(page: Page): Promise<void> {
  await executeCommand(page, 'activateChat');
  await expect(page.locator("iframe[title='RAI Assistant']")).toBeVisible({ timeout: 15000 });
  await expect.poll(() => getChatState(page), { timeout: 60000, intervals: [1000] }).toBe('ready');
}

test.describe('RAI Assistant project context with no project open (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('reports no project and an empty manifest instead of listing the working directory', async ({ rstudioPage: page }) => {
    test.setTimeout(180000);

    // A project-less session cannot be assumed, even from a spec file of its
    // own. A full-suite run executes every spec against ONE sandbox home, so
    // RStudio restores the last project an earlier spec opened into this
    // session -- which is why this passes when the file is run alone and fails
    // in the full gate. Close it explicitly instead. Documents are closed
    // without saving first so a restored dirty buffer cannot raise a save
    // prompt and wedge the close.
    if (await page.evaluate(() => (window as any).rstudio?.project?.isActive?.() ?? false)) {
      await page.evaluate(() => { (window as any).rstudio.documents.closeAllNoSave(); });
      await page.evaluate(() => { (window as any).rstudio.commands.closeProject(); });
      // ready flips false then true across a project close (e2e/rstudio/CLAUDE.md).
      await page.waitForFunction(
        () => (window as any).rstudio?.ready === true &&
          ((window as any).rstudio?.project?.isActive?.() ?? false) === false,
        undefined,
        { timeout: 90000 },
      );
    }

    // Guard the premise rather than skipping: a silent skip here would report
    // green while covering nothing.
    expect(await page.evaluate(() => (window as any).rstudio?.project?.isActive?.() ?? false)).toBe(false);

    // A workspace is created on disk but deliberately never opened. If the
    // working-directory fallback ever came back, these files are the kind of
    // thing a $HOME-rooted walk would be listing.
    raiTest = await setupScriptedRaiTest(
      'context-connectors-no-project',
      'fake-claude-provider-context-connectors.mjs',
      {
        'analysis.R': "# seeded by the test harness\nrai_ctx_noop <- function() invisible(NULL)\n",
        'notes.md': '# notes\n',
      },
      { object_names: ['rai_ctx_absent'] },
    );

    await openAssistant(page);
    const dataFile = path.join(raiTest.stateDir, 'context-connectors-data.json');
    await expect.poll(() => readData(dataFile), { timeout: 60000, intervals: [500] }).not.toBeNull();
    const data = readData(dataFile)!;

    // The call must still succeed -- this is a bounded, honest "nothing to
    // report", not an error the model would retry differently.
    const projectCalls = data.transcript.filter((entry) => entry.tool === 'get_project_context');
    expect(projectCalls).toHaveLength(1);
    expect(projectCalls[0].arguments).toEqual({});
    expect((projectCalls[0].response as { error?: unknown })?.error).toBeUndefined();

    const project = data.project_result;
    expect(project.project_active).toBe(false);

    // The two path-derived fields carry the disclosure: root_name is the
    // account name when the root is $HOME.
    expect(project.root_name).toBeNull();
    expect(project.working_directory).toBeNull();

    // Nothing anywhere in the payload may be a path or a home-directory name.
    const serialized = JSON.stringify(project);
    expect(serialized).not.toContain('/');
    expect(serialized).not.toContain('analysis.R');
    expect(serialized).not.toContain('notes.md');

    // Still a read-only path: no proposal, no approval, no execution.
    expect(data.transcript.filter((entry) => entry.tool === 'run_r')).toHaveLength(0);
    expect(data.transcript.filter((entry) => entry.tool === 'edit_document')).toHaveLength(0);
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);
  });
});
