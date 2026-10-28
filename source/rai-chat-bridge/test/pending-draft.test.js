import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingDraftHistory } from '../public/pending-draft.js';

test('staging preserves user text, order, and exact multiline content', () => {
  const history = new PendingDraftHistory();
  history.observe('Existing draft');
  assert.equal(history.stage('Existing draft', 'Writing\nsecond line'), 'Existing draft\nWriting\nsecond line');
  assert.equal(history.stage(history.value, 'Analysis'), 'Existing draft\nWriting\nsecond line\nAnalysis');
  assert.equal(history.undo(history.value).value, 'Existing draft\nWriting\nsecond line');
  assert.equal(history.undo(history.value).value, 'Existing draft');
  assert.equal(history.canUndo, false);
});

test('undo tracks preceding edits without erasing subsequent user text', () => {
  const history = new PendingDraftHistory();
  history.stage('', 'review');
  history.observe('prefix review');
  history.observe('prefix review suffix');
  assert.deepEqual(history.undo(history.value), { value: 'prefix  suffix', undone: true });
});

test('undo refuses changed staged text and never deletes edits ambiguously', () => {
  const history = new PendingDraftHistory();
  history.stage('user', 'analysis');
  history.observe('user\nanalySed more');
  const result = history.undo(history.value);
  assert.equal(result.undone, false);
  assert.equal(result.value, 'user\nanalySed more');
  assert.match(result.reason, /risk removing your changes/);
  history.clear();
  assert.equal(history.canUndo, false);
  assert.equal(history.value, '');
});

test('staging identical snippets and undo never submits or removes earlier copy', () => {
  const history = new PendingDraftHistory();
  history.stage('', 'same');
  history.stage(history.value, 'same');
  assert.equal(history.undo(history.value).value, 'same');
  assert.equal(history.undo(history.value).value, '');
});
