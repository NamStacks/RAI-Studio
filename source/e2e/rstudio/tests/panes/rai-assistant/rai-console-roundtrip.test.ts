import type { FrameLocator } from '@playwright/test';
import { test, expect } from '@fixtures/rstudio.fixture';
import { requireAiCredentials } from '@utils/ai-credentials';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { openFreshLiveRaiAssistant } from './live-rai.fixture';

// terminal.js is loaded as an ES module (`<script type="module">`), so its
// top-level `const term = new Terminal(...)` lives in module scope, not on
// `window`/global scope. terminal.js publishes the live instance explicitly
// as `window.__raiTerm` so this reads a real, race-free handle instead of
// assuming classic-script global leakage.
function readTerminalText(frame: FrameLocator): Promise<string> {
  return frame.locator('#term').evaluate(() => {
    const t = (window as any).__raiTerm;
    if (!t?.buffer?.active) return '';
    const buf = t.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
  });
}

// Live end-to-end proof of the RAI-Studio acceptance path: a real CLI session
// running inside the Assistant pane's embedded terminal proposes an R Console
// run, Full Auto accepts the parser-valid R code without an approval card,
// it enters that code as real Console input, and the result is captured
// natively (see SessionRaiAssistant.cpp) rather than evaluated by a wrapper.
//
// Requires the `claude` CLI to be installed and already authenticated on the
// host (the bridge shells out to it directly -- see ~/.raistudio/assistant.json).
// Real OAuth credentials are seeded into the sandbox by sandbox-setup.ts; see
// requireAiCredentials for the skip-when-unseeded behavior.
test.describe('RAI Assistant console round trip', { tag: ['@ai'] }, () => {
  requireAiCredentials(test, 'claude');

  test('assistant runs R code in the Console via native approval', async ({ rstudioPage: page }) => {
    test.setTimeout(180000);

    const consoleActions = new ConsolePaneActions(page);
    await consoleActions.clearConsole();

    // RAI bridge is the sole assistant surface (see ChatPresenter.java);
    // Reset Assistant creates a clean bridge after any preceding scripted
    // spec deliberately tore its fake bridge down.
    await openFreshLiveRaiAssistant(page);

    const frame = page.frameLocator("iframe[title='RAI Assistant']");

    // Click xterm's own hidden input textarea directly -- clicking the
    // outer #term container can miss focusing it inside a cross-origin
    // iframe nested in Electron.
    const termInput = frame.locator('.xterm-helper-textarea');
    await termInput.click();
    const message = 'Run 20 + 22 in the active RStudio Console, then tell me the result.';
    await page.keyboard.type(message, { delay: 20 });

    // Confirm the keystrokes actually reached the pty before waiting on a
    // native approval card that would otherwise never arrive.
    await expect.poll(() => readTerminalText(frame), { timeout: 10000, intervals: [500] })
      .toContain('Run 20 + 22');

    await page.keyboard.press('Enter');

    // Full Auto is enabled for this live Console path. Strict parser-valid R
    // proposals therefore execute without a visible card; document-edit tests
    // separately prove edits remain Allow-once gated.
    const approvalCard = page.locator('.rai-approval-card');
    await expect(approvalCard).toHaveCount(0);

    // The native Console must show the raw approved source and its real
    // result -- never a `.rs.rai.consoleRun(...)` wrapper line.
    // Live CLI planning can take longer than the local Console dispatch itself.
    // Bound it independently so a provider response delay is not misreported as
    // a native Console/Full-Auto failure.
    await expect(consoleActions.consolePane.consoleOutput).toContainText('20 + 22', { timeout: 120000 });
    await expect(consoleActions.consolePane.consoleOutput).toContainText('[1] 42', { timeout: 15000 });
    await expect(consoleActions.consolePane.consoleOutput).not.toContainText('.rs.rai.consoleRun');
    await expect(approvalCard).toHaveCount(0);

    // The interactive loop is incomplete unless the native result is returned
    // to the same Claude Code PTY that submitted run_r. Assert that its live
    // xterm buffer receives the Console result, rather than proving only the
    // one-way terminal -> Console path.
    await expect.poll(() => readTerminalText(frame), { timeout: 30000, intervals: [500] })
      .toContain('42');
  });
});
