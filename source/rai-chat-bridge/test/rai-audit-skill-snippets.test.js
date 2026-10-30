import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateRConsoleProposal } from '../rcode-distiller.js';

const skillText = name => readFileSync(fileURLToPath(new URL(`../skills/rai-audit/${name}`, import.meta.url)), 'utf8');

const fencedRBlocks = text => {
  const blocks = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^```r\s*$/.test(lines[i])) continue;
    const start = i + 1;
    while (i + 1 < lines.length && !/^```\s*$/.test(lines[i + 1])) i += 1;
    i += 1;
    blocks.push({ line: start, code: lines.slice(start, i).join('\n') });
  }
  return blocks;
};

const rscript = spawnSync('Rscript', ['--version'], { encoding: 'utf8' });
const hasR = rscript.status === 0;

test('every fenced r block in the rai-audit skill is found', () => {
  assert.ok(fencedRBlocks(skillText('scientific-checks.md')).length >= 6);
});

test('every fenced r block in the rai-audit skill is one R statement', { skip: hasR ? false : 'Rscript not on PATH' }, () => {
  const bad = [];
  for (const name of ['SKILL.md', 'scientific-checks.md']) {
    for (const block of fencedRBlocks(skillText(name))) {
      const run = spawnSync('Rscript', ['--vanilla', '-e', 'cat(length(parse(text = readLines("stdin", warn = FALSE), keep.source = FALSE)))'], { input: block.code, encoding: 'utf8' });
      if (run.status !== 0 || run.stdout.trim() !== '1') bad.push(`${name}:${block.line} parsed as ${run.stdout.trim() || run.stderr.trim()}`);
    }
  }
  assert.deepEqual(bad, [], 'run_r accepts exactly one R statement per call: wrap multi-step checks in local({ ... })');
});

test('every fenced r block in the rai-audit skill passes the run_r proposal validator', () => {
  const bad = [];
  for (const name of ['SKILL.md', 'scientific-checks.md']) {
    for (const block of fencedRBlocks(skillText(name))) {
      try { validateRConsoleProposal({ language: 'R', target: 'console', code: block.code }); }
      catch (error) { bad.push(`${name}:${block.line} ${error.message}`); }
    }
  }
  assert.deepEqual(bad, []);
});

test('rai-audit skill snippets avoid constructs the run_r policy refuses', () => {
  for (const block of fencedRBlocks(skillText('scientific-checks.md'))) {
    assert.doesNotMatch(block.code, /:::/, `line ${block.line}`);
    assert.doesNotMatch(block.code, /\b(anyDuplicated|NROW|colSums|ggplot_build|as\.Date|table|vapply)\s*\(/, `line ${block.line}`);
    assert.doesNotMatch(block.code, /\$(data|labels)\b/, `line ${block.line}`);
  }
});

test('rai-audit skill prose uses American spelling', () => {
  for (const name of ['SKILL.md', 'scientific-checks.md']) {
    const prose = skillText(name).replace(/`[^`]*`/g, '');
    assert.doesNotMatch(prose, /\b(colour|grey|cancelled|behaviour|analyse)\w*/i, name);
  }
});
