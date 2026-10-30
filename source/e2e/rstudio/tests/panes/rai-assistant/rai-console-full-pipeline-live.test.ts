import { test, expect } from '@fixtures/rstudio.fixture';
import { requireAiCredentials } from '@utils/ai-credentials';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { openFreshLiveRaiAssistant, readLiveTerminal, submitLivePrompt } from './live-rai.fixture';

// Live, real-Claude-CLI proof that RAI Assistant drives real Bioconductor
// differential-expression work (DESeq2 + apeglm shrinkage, limma-voom) through
// chat -> Full Auto strict Console -> real Console, and returns the result to
// the same CLI session.
//
// History: these tests originally asked the assistant to source() the
// standalone TCGA-LUAD pipeline scripts. That depends on model discretion and
// is not deterministic: the bridge prompt tells the assistant not to call
// source() (figure-inspection guidance), but the product does not enforce it:
// with Full Auto on, any parser-valid proposal runs. The live gate saw the
// assistant decline in one run and comply in the next (live-claude-2 vs
// live-claude-rc2-1, 2026-09-25), and the real scripts also download recount3
// data. So a source() step is neither asserted nor attempted here. Each test
// runs a visible single-statement analysis through the real Console instead.
//
// Counts are simulated with a fixed seed and a planted 4x effect in genes
// 1..40, so the assertion (planted genes detected) is deterministic.
const DESEQ2_CODE =
  '{ set.seed(1); n <- 400; grp <- factor(rep(c("never_smoker","smoker"), each = 6)); ' +
  'mu <- matrix(rep(rgamma(n, 2, 0.02), 12), n); mu[1:40, 7:12] <- mu[1:40, 7:12] * 4; ' +
  'cts <- matrix(rnbinom(n * 12, mu = mu, size = 10), n, dimnames = list(paste0("g", 1:n), NULL)); ' +
  'dds <- DESeq2::DESeq(DESeq2::DESeqDataSetFromMatrix(cts, data.frame(grp), ~ grp), quiet = TRUE); ' +
  'res <- DESeq2::lfcShrink(dds, coef = "grp_smoker_vs_never_smoker", type = "apeglm", quiet = TRUE); ' +
  'cat(sprintf("RAI_LIVE_DESEQ2_APEGLM_DONE sig=%d planted_hits=%d\\n", ' +
  'sum(res$padj < 0.05, na.rm = TRUE), sum(res$padj[1:40] < 0.05, na.rm = TRUE))) }';

const LIMMA_CODE =
  '{ set.seed(2); n <- 400; grp <- factor(rep(c("never_smoker","smoker"), each = 6)); ' +
  'mu <- matrix(rep(rgamma(n, 2, 0.02), 12), n); mu[1:40, 7:12] <- mu[1:40, 7:12] * 4; ' +
  'cts <- matrix(rnbinom(n * 12, mu = mu, size = 10), n); ' +
  'y <- edgeR::calcNormFactors(edgeR::DGEList(cts)); design <- model.matrix(~ grp); ' +
  'fit <- limma::eBayes(limma::lmFit(limma::voom(y, design), design)); ' +
  'tt <- limma::topTable(fit, coef = 2, number = Inf, sort.by = "none"); ' +
  'cat(sprintf("RAI_LIVE_LIMMA_VOOM_DONE sig=%d planted_hits=%d\\n", ' +
  'sum(tt$adj.P.Val < 0.05), sum(tt$adj.P.Val[1:40] < 0.05))) }';

function ask(code: string): string {
  return 'In the active RStudio Console, run exactly this single R statement unchanged, then ' +
    'tell me the printed result: ' + code;
}

test.describe('RAI Assistant live DESeq2 + limma-voom demo', { tag: ['@ai'] }, () => {
  requireAiCredentials(test, 'claude');

  test('runs real DESeq2 + apeglm via Full Auto', async ({ rstudioPage: page }) => {
    test.setTimeout(600000);
    const consoleActions = new ConsolePaneActions(page);
    const out = consoleActions.consolePane.consoleOutput;
    const approvalCard = page.locator('.rai-approval-card');
    await consoleActions.clearConsole();
    await openFreshLiveRaiAssistant(page);

    await submitLivePrompt(page, ask(DESEQ2_CODE), 5);
    await expect(out).toContainText('RAI_LIVE_DESEQ2_APEGLM_DONE', { timeout: 420000 });
    await expect(out).toContainText(/RAI_LIVE_DESEQ2_APEGLM_DONE sig=\d+ planted_hits=[1-9]\d*/);
    await expect(out).not.toContainText('.rs.rai.consoleRun');
    await expect(approvalCard).toHaveCount(0);
    await expect.poll(async () => (await readLiveTerminal(page)).includes('planted_hits'),
      { timeout: 120000, intervals: [1000] }).toBe(true);
  });

  test('runs real limma-voom via Full Auto', async ({ rstudioPage: page }) => {
    test.setTimeout(600000);
    const consoleActions = new ConsolePaneActions(page);
    const out = consoleActions.consolePane.consoleOutput;
    const approvalCard = page.locator('.rai-approval-card');
    await consoleActions.clearConsole();
    await openFreshLiveRaiAssistant(page);

    await submitLivePrompt(page, ask(LIMMA_CODE), 5);
    await expect(out).toContainText('RAI_LIVE_LIMMA_VOOM_DONE', { timeout: 420000 });
    await expect(out).toContainText(/RAI_LIVE_LIMMA_VOOM_DONE sig=\d+ planted_hits=[1-9]\d*/);
    await expect(out).not.toContainText('.rs.rai.consoleRun');
    await expect(approvalCard).toHaveCount(0);
    await expect.poll(async () => (await readLiveTerminal(page)).includes('planted_hits'),
      { timeout: 120000, intervals: [1000] }).toBe(true);
  });
});
