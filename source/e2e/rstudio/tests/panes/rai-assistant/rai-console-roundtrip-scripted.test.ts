import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import { executeCommand, getChatState } from '@utils/commands';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

const COMPLEX_R_CODE = "{ input <- read.csv('rai-mcp-input.csv'); stopifnot(nrow(input) == 4L, identical(names(input), c('group', 'score')), all(input$group %in% c(0, 1))); analysis <- transform(input, centered = score - mean(score)); stopifnot(identical(names(input), c('group', 'score'))); group_mean <- aggregate(score ~ group, data = analysis, FUN = mean); fit <- lm(score ~ group, data = analysis); prediction <- predict(fit, newdata = data.frame(group = c(0, 1))); cat(sprintf('ROWS=%d GROUP_MEANS=%.1f,%.1f SLOPE=%.1f PRED=%.1f,%.1f CENTERED_SUM=%.1f\\n', nrow(input), group_mean$score[1], group_mean$score[2], unname(coef(fit)[['group']]), prediction[1], prediction[2], sum(analysis$centered))) }";

// Live proof of the RAI-Studio native round trip -- approval card shows the
// exact raw code, approving it enters that code as real Console input, and
// the result is captured natively (SessionRaiAssistant.cpp) -- without
// depending on a live LLM or any credentials. The bridge's "claude" provider
// is pointed at fixtures/fake-claude-provider.mjs, a deterministic stand-in
// that speaks the exact same MCP protocol a real Claude Code tool call would
// (see rai-native-mcp.js): call run_r, retry on approval_required, poll
// get_run_result once queued. It exercises the real native /run + /result
// endpoints and the real approval card; only "an LLM decides to call the
// tool" is replaced with a fixed decision.
test.describe('RAI Assistant console round trip (scripted provider, no LLM credentials)', () => {
  let raiTest: Awaited<ReturnType<typeof setupScriptedRaiTest>> | undefined;

  test.beforeEach(async () => {
    raiTest = await setupScriptedRaiTest('approval', 'fake-claude-provider.mjs', {
      'rai-mcp-input.csv': 'group,score\n0,10\n1,20\n0,14\n1,24\n',
    });
  });

  test.afterEach(async ({ rstudioPage: page }) => {
    await teardownScriptedRaiTest(page, raiTest?.stateDir);
  });

  test('scripted run_r proposal reaches native approval and the real Console', async ({ rstudioPage: page }) => {
    test.setTimeout(120000);

    const approvalRpc: string[] = [];
    page.on('response', async (response) => {
      const postData = response.request().postData();
      if (postData?.includes('rai_submit_approval'))
        approvalRpc.push(`${postData}\n${await response.text()}`);
    });

    // ApplicationAutomation.project.path() returns the active .Rproj file,
    // but in the session's home-relative form (~/...), while the host-side
    // fixture needs the absolute filename to open it. Wait for the new
    // session lifecycle first, then assert the bridge's canonical identity.
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


    // The fake provider submits run_r automatically; approval is rendered by
    // the native workbench, outside the Assistant iframe.

    // RaiApprovalCard renders in ChatPane's own mainPanel_, not inside the
    // iframe (see ChatPane.showApprovalCard).
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);

    // The native Console must show the raw approved source and its real
    // result -- never a `.rs.rai.consoleRun(...)` wrapper line.
    await expect(consoleActions.consolePane.consoleOutput).toContainText("read.csv('rai-mcp-input.csv')", { timeout: 15000 });
    await expect(consoleActions.consolePane.consoleOutput).toContainText('ROWS=4 GROUP_MEANS=12.0,22.0 SLOPE=10.0 PRED=12.0,22.0 CENTERED_SUM=0.0', { timeout: 15000 });
    await expect(consoleActions.consolePane.consoleOutput).not.toContainText('.rs.rai.consoleRun');

    // The result must also flow back to the calling MCP client. The iframe
    // itself may be re-created by the bridge after a provider reconnect, so
    // assert the deterministic provider-side capture instead of transient
    // xterm scrollback.
    const resultFile = path.join(raiTest!.stateDir, 'result.json');
    await expect.poll(
      () => fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null,
      { timeout: 15000, intervals: [500] },
    ).toMatchObject({
      status: 'ok',
      stdout: expect.stringContaining('ROWS=4 GROUP_MEANS=12.0,22.0 SLOPE=10.0 PRED=12.0,22.0 CENTERED_SUM=0.0'),
    });
  });
});
