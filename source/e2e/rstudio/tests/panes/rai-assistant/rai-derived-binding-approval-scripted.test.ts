import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@fixtures/rstudio.fixture';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { executeCommand, getChatState } from '@utils/commands';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

const seed = "{ forest.plots <- list(structure(list(label = 'before'), class = 'ggplot')); forest.plots.significant <- list(structure(list(label = 'before'), class = 'ggplot')); sig4_dir <- 'derived-old'; make_csx_spearman_hm <- function(x) x; rai_chunk_raw <- data.frame(value = 1:3) }";
const proposals = [
  "forest.plots <- list(structure(list(label = 'after'), class = 'ggplot'))",
  "forest.plots.significant <- list(structure(list(label = 'sig'), class = 'ggplot'))",
  "sig4_dir <- 'derived-new'",
  "make_csx_spearman_hm <- function(x) { inner <- function(y) y + 1; inner(x) }",
  "rai_chunk_raw$value <- 0L",
  "forest.plots[[1L]] <- NULL",
  "sig4_dir <- '.Renviron'",
  "source('uninspected.R')",
];
const names = ['forest.plots', 'forest.plots.significant', 'sig4_dir', 'make_csx_spearman_hm'];
const kinds = ['plots', 'plots', 'path', 'helper'];

test('one-time native derived approval preserves originals and exact Console capture @serial', async ({ rstudioPage: page }) => {
  test.setTimeout(240000);
  const fixture = await setupScriptedRaiTest('derived-binding-approval', 'fake-claude-provider-matrix.mjs',
    {}, {proposals:proposals.map(code=>({language:'R',target:'console',code})),
      authorizations:names.map((name,i)=>({name,kind:kinds[i]})),waitForFile:'start-authorizations'}, true);
  try {
    await page.evaluate(file => (window as any).rstudio.project.open(file), fixture.projectFile);
    await page.waitForFunction(({ projectPath }) => (window as any).rstudio?.ready === true &&
      (window as any).rstudio?.project?.path?.() === projectPath,
      { projectPath: fixture.projectPath }, { timeout: 60000 });
    const consoleActions = new ConsolePaneActions(page);
    await consoleActions.executeInConsole(seed, { wait: true });
    await executeCommand(page, 'activateChat');
    await expect.poll(() => getChatState(page), { timeout: 60000 }).toBe('ready');
    const resultsPath = path.join(fixture.stateDir, 'results.json');
    expect(fs.existsSync(resultsPath)).toBe(false);
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);
    fs.writeFileSync(path.join(fixture.stateDir,'start-authorizations'),'start');
    const authorizedPath = path.join(fixture.stateDir, 'authorized.json');
    await expect.poll(() => fs.existsSync(authorizedPath) ?
      JSON.parse(fs.readFileSync(authorizedPath,'utf8')).length : 0,
      {timeout:30000}).toBe(names.length);
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);
    await expect.poll(() => fs.existsSync(resultsPath) ?
      JSON.parse(fs.readFileSync(resultsPath,'utf8')).length : 0,
      {timeout:90000,intervals:[500]}).toBe(proposals.length);
    const results = JSON.parse(fs.readFileSync(resultsPath,'utf8'));
    for (let i=0; i<4; i++) {
      expect(results[i].result.status).toBe('ok');
      expect(results[i].result.data_effects.bindings_rebound_authorized).toContain(names[i]);
      expect(results[i].result.data_effects.original_data_changed_observed).toBe(false);
    }
    for (let i=4; i<proposals.length; i++) {
      expect(results[i].result.status).toBe('error');
      expect(JSON.stringify(results[i].result)).toMatch(/refused/);
      expect(results[i].result.run_id).toBeUndefined();
    }
    await consoleActions.executeInConsole(
      "stopifnot(identical(rai_chunk_raw$value, 1:3), identical(forest.plots[[1]]$label, 'after'), identical(sig4_dir, 'derived-new'), identical(make_csx_spearman_hm(2L), 3))",
      {wait:true});
  } finally { await teardownScriptedRaiTest(page, fixture.stateDir); }
});
