import { test, expect } from '@fixtures/rstudio.fixture';
import { requireAiCredentials } from '@utils/ai-credentials';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { openFreshLiveRaiAssistant } from './live-rai.fixture';

// Live, real-Claude-CLI proof requested directly by the user: drive RAI
// Assistant's own chat pane to propose real R code, let the bridge approve it
// automatically (no approval card), and read the real result from the real Console --
// using a small piece of representative TCGA-LUAD work (smoking-status
// group counts) rather than a toy arithmetic example.
function readTerminalText(frame: import('@playwright/test').FrameLocator): Promise<string> {
  return frame.locator('#term').evaluate(() => {
    const t = (window as any).__raiTerm;
    if (!t?.buffer?.active) return '';
    const buf = t.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n');
  });
}

test.describe('RAI Assistant live TCGA-style Console demo', { tag: ['@ai'] }, () => {
  requireAiCredentials(test, 'claude');

  test('assistant runs a real R data-summary snippet in the Console with automatic approval', async ({ rstudioPage: page }) => {
    test.setTimeout(180000);

    const consoleActions = new ConsolePaneActions(page);
    await consoleActions.clearConsole();

    await openFreshLiveRaiAssistant(page);
    const frame = page.frameLocator("iframe[title='RAI Assistant']");

    const termInput = frame.locator('.xterm-helper-textarea');
    await termInput.click();
    const message =
      'In the active RStudio Console, run this exact R code to summarize a small ' +
      'mock smoking-status cohort table, then tell me the result: ' +
      "{ df <- data.frame(group = c('never_smoker','smoker','smoker','never_smoker','smoker'), " +
      "expr = c(4.1, 7.8, 6.9, 3.7, 8.2)); agg <- aggregate(expr ~ group, data = df, FUN = mean); " +
      "cat(sprintf('never_smoker_mean=%.2f smoker_mean=%.2f\\n', agg$expr[agg$group=='never_smoker'], " +
      "agg$expr[agg$group=='smoker'])) }";
    await page.keyboard.type(message, { delay: 15 });
    await expect.poll(() => readTerminalText(frame), { timeout: 10000, intervals: [500] })
      .toContain('never_smoker_mean');
    await page.keyboard.press('Enter');

    // The bridge forces automatic approval, so the run proceeds with no card.
    await expect(consoleActions.consolePane.consoleOutput).toContainText('aggregate(expr ~ group', { timeout: 90000 });
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);
    await expect(consoleActions.consolePane.consoleOutput).toContainText('never_smoker_mean=3.90 smoker_mean=7.63', { timeout: 15000 });
    await expect(consoleActions.consolePane.consoleOutput).not.toContainText('.rs.rai.consoleRun');
  });
});
