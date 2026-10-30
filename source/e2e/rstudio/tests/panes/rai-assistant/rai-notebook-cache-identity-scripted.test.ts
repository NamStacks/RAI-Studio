import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import { executeCommand, getChatState } from '@utils/commands';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

const source = '---\ntitle: "Cache provenance"\noutput: html_notebook\n---\n\n```{r cache_chunk}\nplot(1:3)\n```\n';

test('notebook cache image rejects a changed unsaved buffer without executing R @serial', async ({ rstudioPage: page }) => {
  test.setTimeout(160000);
  const fixture = await setupScriptedRaiTest('notebook-cache-identity',
    'fake-claude-provider-matrix.mjs', {'cache.Rmd': source},
    {proposals:[],notebookObservation:true,waitForFile:'start-notebook-observation'}, true);
  try {
    await page.evaluate(file => (window as any).rstudio.project.open(file), fixture.projectFile);
    await page.waitForFunction(({ projectPath }) => (window as any).rstudio?.ready === true &&
      (window as any).rstudio?.project?.path?.() === projectPath,
      {projectPath:fixture.projectPath},{timeout:60000});
    const rmdPath = path.join(path.dirname(fixture.projectFile),'cache.Rmd');
    await page.evaluate(file => (window as any).rstudio.documents.open(file), rmdPath);
    await expect.poll(() => page.evaluate(() => !!(window as any).rstudio.documents.activeEditor()),
      {timeout:30000}).toBe(true);
    await executeCommand(page,'activateChat');
    await expect.poll(() => getChatState(page),{timeout:60000}).toBe('ready');
    const promptsBefore = await page.evaluate(() => (window as any).rstudio.console.promptCount as number);
    fs.writeFileSync(path.join(fixture.stateDir,'start-notebook-observation'),'start');
    const beforePath = path.join(fixture.stateDir,'notebook-before.json');
    await expect.poll(() => fs.existsSync(beforePath),{timeout:30000}).toBe(true);
    const before = JSON.parse(fs.readFileSync(beforePath,'utf8'));
    expect(before.inventory.document_id).toBe(before.active.document_id);
    expect(before.inventory.content_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(before.inventory.execution_origin).toBe('historical_notebook_cache_not_console_run');
    const diskBefore = fs.readFileSync(rmdPath);
    await page.evaluate(() => {
      const editor = (window as any).rstudio.documents.activeEditor();
      editor.setValue(editor.getValue() + '\n# unsaved cache identity change\n',1);
    });
    fs.writeFileSync(path.join(fixture.stateDir,'notebook-buffer-edited'),'edited');
    const afterPath = path.join(fixture.stateDir,'notebook-after.json');
    await expect.poll(() => fs.existsSync(afterPath),{timeout:45000}).toBe(true);
    const after = JSON.parse(fs.readFileSync(afterPath,'utf8'));
    expect(after.changed.content_digest).not.toBe(before.inventory.content_digest);
    expect(after.changed.dirty).toBe(true);
    expect(after.image.status).toBe('error');
    expect(after.image.error).toMatch(/open document changed since notebook inventory/);
    expect(fs.readFileSync(rmdPath).equals(diskBefore)).toBe(true);
    expect(await page.evaluate(() => (window as any).rstudio.console.promptCount as number)).toBe(promptsBefore);
    expect(fs.existsSync(path.join(fixture.stateDir,'results.json'))).toBe(false);
  } finally { await teardownScriptedRaiTest(page,fixture.stateDir); }
});
