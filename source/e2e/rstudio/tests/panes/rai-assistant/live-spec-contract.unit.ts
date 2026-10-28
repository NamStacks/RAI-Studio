// Deterministic regression for the live Claude spec contract (no GUI, no CLI).
// Run: npx tsx tests/panes/rai-assistant/live-spec-contract.unit.ts
//
// Live-gate finding (live-claude-rc2-1, 2026-09-25): the full-pipeline test
// asserted that the assistant would DECLINE a source() request. The product
// does not enforce that: with Full Auto on, any parser-valid proposal runs,
// and source() is only discouraged by the bridge prompt. The model declined in
// one run and complied in the next, so the assertion flaked on model
// discretion rather than testing the product. Live specs may assert only
// product-enforced behavior, and must not embed private host paths.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const dir = __dirname;
const specs = fs.readdirSync(dir).filter((f) => /-live\.test\.ts$|rai-console-roundtrip\.test\.ts$/.test(f));
assert.equal(specs.length, 3, `expected the 3 live spec files, found ${specs.join(', ')}`);

let checks = 0;
for (const f of specs) {
  const code = fs.readFileSync(path.join(dir, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // 1. No prompt may ask the assistant to source() a script: its outcome is
  //    model discretion under Full Auto, not product-enforced.
  assert.doesNotMatch(code, /source\(\s*['"\\]/, `${f}: live prompt asks for source()`);
  checks++;
  // 2. No private host paths in committed specs.
  assert.doesNotMatch(code, /\/Users\/[A-Za-z0-9_.-]+\//, `${f}: embeds a private /Users path`);
  checks++;
}

// 3. The full-pipeline spec still proves both real Bioconductor analyses end to
//    end (Console marker with planted hits, no approval card, result back in CLI).
const fp = fs.readFileSync(path.join(dir, 'rai-console-full-pipeline-live.test.ts'), 'utf8');
for (const marker of ['RAI_LIVE_DESEQ2_APEGLM_DONE', 'RAI_LIVE_LIMMA_VOOM_DONE']) {
  assert.match(fp, new RegExp(`toContainText\\(/${marker} sig=\\\\d\\+ planted_hits=\\[1-9\\]`), `${marker} hit assertion missing`);
  checks++;
}
assert.equal((fp.match(/approvalCard\)\.toHaveCount\(0\)/g) || []).length, 2, 'Full Auto no-card assertions');
assert.equal((fp.match(/includes\('planted_hits'\)/g) || []).length, 2, 'result-returns-to-CLI assertions');
assert.match(fp, /DESeq2::lfcShrink\([^)]*type = \\?"apeglm\\?"/, 'apeglm shrinkage step missing');
assert.match(fp, /limma::voom\(/, 'voom step missing');
checks += 4;

console.log(`live-spec-contract: ${checks} checks passed`);
