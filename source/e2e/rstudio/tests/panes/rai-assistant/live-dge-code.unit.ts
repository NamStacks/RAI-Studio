// Deterministic regression for the live DGE statements (no GUI, no CLI).
// Proves each statement: parses as exactly ONE top-level R expression, calls
// nothing on the RAI Console denylist that the live contract forbids
// (source/graphics devices/library/...), and prints its marker with planted
// genes detected when evaluated in plain Rscript.
// Run: npx tsx tests/panes/rai-assistant/live-dge-code.unit.ts
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const src = fs.readFileSync(path.join(__dirname, 'rai-console-full-pipeline-live.test.ts'), 'utf8');
function extract(name: string): string {
  const m = src.match(new RegExp(`const ${name} =\\n([\\s\\S]*?);\\n`));
  assert.ok(m, `missing ${name}`);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${m![1]};`)() as string;
}

const banned = /\b(source|sys\.source|library|require|png|pdf|jpeg|svg|dev\.(off|new|copy|print)|system2?|setwd|install\.packages|eval|parse|assign|options|sink|capture\.output)\s*\(/;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dge-'));
for (const [name, marker] of [['DESEQ2_CODE', 'RAI_LIVE_DESEQ2_APEGLM_DONE'], ['LIMMA_CODE', 'RAI_LIVE_LIMMA_VOOM_DONE']] as const) {
  const code = extract(name);
  assert.equal(banned.test(code), false, `${name} uses a denylisted call`);
  const f = path.join(tmp, `${name}.R`);
  fs.writeFileSync(f, code);
  const n = execFileSync('Rscript', ['-e', `cat(length(parse(file='${f}')))`], { encoding: 'utf8' });
  assert.equal(n.trim(), '1', `${name} must be one top-level statement`);
  const out = execFileSync('Rscript', [f], { encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
  const m = out.match(new RegExp(`${marker} sig=(\\d+) planted_hits=(\\d+)`));
  assert.ok(m, `${name} printed no marker: ${out.slice(-300)}`);
  assert.ok(Number(m![2]) >= 20, `${name} detected too few planted genes: ${m![0]}`);
  console.log(`ok ${name}: ${m![0]}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log('live-dge-code: 2 statements verified');
