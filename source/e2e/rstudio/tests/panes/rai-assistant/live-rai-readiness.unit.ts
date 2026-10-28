// Deterministic regression for the live-RAI readiness/echo helpers (no GUI, no CLI).
// Run: npx tsx tests/panes/rai-assistant/live-rai-readiness.unit.ts
import * as assert from 'node:assert/strict';
import { cliPromptReady, terminalKey } from './live-rai.fixture';

// Boot-time screen of a provider CLI before its input box exists.
const booting = 'Claude Code v2.1.282\nOpus 5.5 · Claude API\n~/projects/example\nUpdated to latest.';
assert.equal(cliPromptReady(booting), false);
assert.equal(cliPromptReady(''), false);
// Idle footer drawn once the CLI accepts input.
assert.equal(cliPromptReady(booting + '\n› Try "write a test"\n▸▸ auto mode on (shift+tab to cycle) · ← 1 age'), true);
assert.equal(cliPromptReady('> \n  ? for shortcuts'), true);

// Echo check survives TUI wrapping and box borders.
const msg = "source('/tmp/rai-example/tcga-luad-full-pipeline-deseq2.R')";
const wrapped = "│ > In the active ... source('/tmp/rai-example/tcga-luad-fu │\n│ ll-pipeline-deseq2.R')                                   │";
assert.ok(terminalKey(wrapped).includes(terminalKey(msg).slice(-24)));
assert.ok(!terminalKey(booting).includes(terminalKey(msg).slice(-24)));
console.log('live-rai-readiness: 6 checks passed');
