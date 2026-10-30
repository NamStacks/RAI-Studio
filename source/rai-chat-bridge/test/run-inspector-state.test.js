import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RUN_INSPECTOR_SAFETY_COPY, createRunInspectorState } from '../run-inspector-state.js';

const stalledSnapshot = (state) => ({
  state,
  elapsed_ms: 300000,
  quiet_ms: 300000,
  output_bytes: 8,
  output_growth_bytes: 0,
  deadline_ms: 6900000
});

test('browser inspector state rejects Console output and UI has no raw-output surface', () => {
  const secret = 'RAI_BRIDGE_TOKEN=review-secret-value';
  const inspector = createRunInspectorState();
  assert.throws(() => inspector.update({
    ...stalledSnapshot('running'),
    stdout_tail: secret,
    stderr_tail: 'arbitrary provider/session output',
    stdout: secret,
    stderr: 'arbitrary Console output'
  }), /unsupported fields/);
  assert.deepEqual(inspector.get(), { state: 'idle' });

  const client = readFileSync(fileURLToPath(new URL('../public/terminal.js', import.meta.url)), 'utf8');
  const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
  const css = readFileSync(fileURLToPath(new URL('../public/terminal.css', import.meta.url)), 'utf8');
  assert.doesNotMatch(client, /snapshot\.(?:stdout|stderr)(?:_tail)?|run-inspector-(?:stdout|stderr)/);
  assert.doesNotMatch(html, /run-inspector-(?:stdout|stderr)/);
  assert.doesNotMatch(css, /run-inspector-(?:stdout|stderr)|#run-inspector\s+pre/);
  assert.equal(`${client}\n${html}\n${css}`.includes(secret), false);
});

test('stalled and timed-out states expose exact safety copy without controls', () => {
  const inspector = createRunInspectorState();
  for (const state of ['stalled', 'timed_out']) {
    const snapshot = inspector.update(stalledSnapshot(state));
    assert.equal(snapshot.safety_copy, RUN_INSPECTOR_SAFETY_COPY);
    assert.equal(Object.hasOwn(snapshot, 'actions'), false);
    assert.equal(Object.hasOwn(snapshot, 'command'), false);
  }
});

test('idle inspector removal refits the terminal and inspector markup has no controls', () => {
  const client = readFileSync(fileURLToPath(new URL('../public/terminal.js', import.meta.url)), 'utf8');
  const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
  assert.match(client, /snapshot\.state === 'idle'[\s\S]*inspectorEl\.hidden = true;\s*fit\.fit\(\);\s*return;/);
  const inspectorMarkup = html.match(/<section id="run-inspector"[\s\S]*?<\/section>/)?.[0] || '';
  assert.doesNotMatch(inspectorMarkup, /<button\b|<input\b|<form\b/i);
});
