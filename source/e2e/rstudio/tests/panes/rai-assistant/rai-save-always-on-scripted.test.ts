import fs from 'fs';
import path from 'path';
import { test, expect } from '@fixtures/rstudio.fixture';
import { documentOpen, executeCommand, getChatState } from '@utils/commands';
import { AceEditor } from '@pages/ace_editor.page';
import { sandboxHome, setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

const ORIGINAL = "threshold <- 0.05\nmessage('keep this line 😀')\n";
const REPLACED = "threshold <- 0.01\nmessage('keep this line 😀')\n";

// RAI saving is always on: a stored saveOnEdit value, whatever it is, has no
// control in Settings, no effect on the edit, and is never rewritten.
const CASES: { id: string; title: string; seeded: unknown }[] = [
  { id: 'save-always-false', title: 'a stored saveOnEdit false', seeded: false },
  { id: 'save-always-string', title: 'a stored saveOnEdit "false" string', seeded: 'false' },
];

for (const { id, title, seeded } of CASES) {
  test(`Settings: RAI saving has no control and ${title} still saves the applied edit @serial`, async ({ rstudioPage: page }) => {
    test.setTimeout(120000);
    const fixture = await setupScriptedRaiTest(id, 'fake-claude-provider-editor-edit.mjs', { 'analysis.R': ORIGINAL });
    try {
      const configFile = path.join(sandboxHome(), '.raistudio', 'assistant.json');
      const stored = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      fs.writeFileSync(configFile, JSON.stringify({ ...stored, saveOnEdit: seeded }, null, 2), { mode: 0o600 });

      await page.evaluate(file => (window as any).rstudio.project.open(file), fixture.projectFile);
      await page.waitForFunction(({ projectPath }) => (window as any).rstudio?.ready === true &&
        (window as any).rstudio?.project?.path?.() === projectPath,
        { projectPath: fixture.projectPath }, { timeout: 60000 });

      const analysisPath = path.join(path.dirname(fixture.projectFile), 'analysis.R');
      await documentOpen(page, analysisPath);
      const editor = new AceEditor(page, '');
      await expect.poll(() => editor.getValue(), { timeout: 15000 }).toBe(ORIGINAL);

      await executeCommand(page, 'activateChat');
      await expect.poll(() => getChatState(page), { timeout: 60000 }).toBe('ready');
      const frame = page.frameLocator("iframe[title='RAI Assistant']");
      await page.getByRole('button', { name: 'RAI Assistant settings' }).click();
      await expect(frame.locator('#settings-panel')).toBeVisible();
      await expect(frame.locator('#settings-save-on-edit')).toHaveCount(0);
      await expect(frame.locator('#settings-general select')).toHaveCount(0);

      // The scripted provider applies one exact replacement once the chat is ready.
      await expect.poll(
        () => fs.existsSync(path.join(fixture.stateDir, 'result.json'))
          ? JSON.parse(fs.readFileSync(path.join(fixture.stateDir, 'result.json'), 'utf8')) : null,
        { timeout: 30000, intervals: [500] },
      ).toMatchObject({ status: 'applied', replacement: 'threshold <- 0.01' });
      await expect.poll(() => editor.getValue(), { timeout: 15000 }).toBe(REPLACED);
      await expect.poll(
        () => page.evaluate(() => (window as any).rstudio.documents.active()?.dirty as boolean),
        { timeout: 10000 },
      ).toBe(false);
      expect(fs.readFileSync(analysisPath, 'utf8')).toBe(REPLACED);

      expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).toHaveProperty('saveOnEdit', seeded);
    } finally {
      await teardownScriptedRaiTest(page, fixture.stateDir);
    }
  });
}
