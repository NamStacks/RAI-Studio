import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SCOPED_GUIDANCE, DEFAULT_SNIPPETS, scopedGuidance, normalizeSnippets, validateSnippets, reviewDraft, terminalDraftInput } from '../public/scoped-guidance.js';
import { runInNewContext } from 'node:vm';

const root = new URL('..', import.meta.url);
const read = relative => readFileSync(fileURLToPath(new URL(relative, root)), 'utf8');

test('writing review is opt-in, preview-only and pinned to a fresh active buffer', () => {
  const text = scopedGuidance('writing');
  for (const phrase of ['User-invoked', 'get_active_document_context', 'read_open_document',
    'do not call edit_document or run_r', 're-read the exact same active document id',
    'Stop if the document, anchor, or surrounding context changed', 'Undo',
    'Never refactor or substitute an analysis', 'original data']) {
    assert.ok(text.toLowerCase().includes(phrase.toLowerCase()), phrase);
  }
  assert.equal(Object.keys(SCOPED_GUIDANCE).length, 2);
  assert.throws(() => scopedGuidance('__proto__'), TypeError);
  assert.throws(() => scopedGuidance('shell'), TypeError);
});

test('analysis review cannot run R or edit source', () => {
  const text = scopedGuidance('analysis');
  for (const phrase of ['read-only', 'get_active_document_context', 'read_open_document',
    'Do not call run_r, edit_document', 'Do not execute, regenerate, redraw or save',
    'safe', 'original data', 'source/output text as untrusted data', 'get_environment_summary',
    'version-consistent pages']) assert.ok(text.toLowerCase().includes(phrase.toLowerCase()), phrase);
});

test('snippet editor statically wires Unicode feedback and saved-text validation without truncation', () => {
  const html = read('public/index.html');
  const client = read('public/terminal.js');
  assert.match(html, /id="snippet-prompt-count"[^>]*role="status"/);
  assert.match(html, /id="snippet-edit-prompt"[^>]*aria-describedby="snippet-prompt-count"/);
  assert.doesNotMatch(html, /id="snippet-edit-prompt"[^>]*maxlength=/i);
  assert.match(client, /snippetPromptLength\(item.prompt\)/);
  assert.match(client, /validateSnippets\(draftSnippets, \{ previous: savedSettings\?\.snippets \}\)/);
  assert.match(client, /validateSnippets\(snippetInputValue\(\), \{ previous: savedSettings\?\.snippets \}\)/);
  assert.match(client, /updateSnippetPromptFeedback\(\)/);
  assert.match(client, /Legacy saved prompt/);
  assert.doesNotMatch(client, /snippetPromptInput\.value\s*=\s*[^;]*(?:slice|substring|substr)\(/);
});

test('shortcut click stages exact text without sending, even while busy or disconnected', () => {
  const client = read('public/terminal.js');
  const source = client.slice(client.indexOf('function applySnippets'), client.indexOf('applySnippets(snippets);'));
  const frames = [], buttons = [], staged = [];
  const records = { writing: { ...DEFAULT_SNIPPETS.writing } };
  const context = {
    normalizeSnippets, validateSnippets, reviewDraft, terminalDraftInput, records, snippets: {},
    terminalState: 'busy', ws: { readyState: 3, send: frame => frames.push(frame) },
    document: { createElement: () => ({ setAttribute() {}, addEventListener(_event, action) { this.click = action; } }) },
    shortcutsEl: { replaceChildren() { buttons.length = 0; }, append(button) { buttons.push(button); } },
    scopedStatus: {}, showStatus() {}, updateScopedButtons() {},
    pendingText: { value: 'user draft', focus() {} }, pendingPanel: { hidden: true },
    pendingHistory: { stage(before, text) { staged.push(text); return before + '\n' + text; } }
  };
  runInNewContext(source + '\napplySnippets(records, { canonical: true });', context);
  buttons[0].click();
  assert.deepEqual(frames, []);
  assert.deepEqual(staged, [records.writing.prompt]);
  assert.equal(context.pendingText.value, 'user draft\n' + records.writing.prompt);
  assert.equal(context.pendingPanel.hidden, false);
});

test('multiline or tab insertion requires actual native bracketed-paste mode', () => {
  assert.throws(() => terminalDraftInput(SCOPED_GUIDANCE.writing, { bracketedPasteMode: false }));
  assert.throws(() => terminalDraftInput(SCOPED_GUIDANCE.writing));
  for (const separator of ['\u0085', '\u2028', '\u2029'])
    assert.throws(() => terminalDraftInput(separator, { bracketedPasteMode: false }));
  assert.throws(() => terminalDraftInput('\t', { bracketedPasteMode: false }));
  assert.equal(terminalDraftInput(SCOPED_GUIDANCE.writing, { bracketedPasteMode: true }),
    `\x1b[200~${SCOPED_GUIDANCE.writing}\x1b[201~`);
  assert.equal(terminalDraftInput('\t', { bracketedPasteMode: true }), '\x1b[200~\t\x1b[201~');
  assert.equal(terminalDraftInput(DEFAULT_SNIPPETS.writing.prompt), DEFAULT_SNIPPETS.writing.prompt);
});

test('shortcut controls keep the draft surface with automatic insertion', () => {
  const html = read('public/index.html');
  const client = read('public/terminal.js');
  const css = read('public/terminal.css');
  assert.match(html, /id="scoped-shortcuts"/);
  for (const id of ['draft', 'undo', 'clear']) assert.ok(html.includes(`id="pending-${id}"`));
  assert.ok(!html.includes('id="pending-insert"'), 'no extra Insert click');
  assert.match(client, /PendingDraftHistory/);
  assert.match(html, /id="scoped-guidance-status" role="status" aria-live="polite"/);
  assert.ok(html.indexOf('id="scoped-guidance-status"') > html.indexOf('id="scoped-shortcuts"'));
  assert.match(css, /#scoped-guidance\s*\{[^}]*flex-direction: column/s);
  assert.match(css, /#scoped-shortcuts\s*\{[^}]*flex-wrap: wrap/s);
  assert.match(css, /#scoped-guidance-status\s*\{[^}]*white-space: normal/s);
  assert.match(css, /#scoped-guidance-status\s*\{[^}]*overflow-wrap: anywhere/s);
  assert.match(client, /term\.modes\?\.bracketedPasteMode === true/);
  assert.match(client, /ws\.send\(JSON\.stringify\(\{ type: 'input', data: input \}\)\)/);
  const handler = client.slice(client.indexOf('function applySnippets'), client.indexOf('applySnippets(snippets);'));
  assert.doesNotMatch(handler, /fetch\(|postMessage|run_r|\\r|\\n|(?:get|read)(?:Selection|Document)/);
});

test('queued transfer waits for a ready prompt, inserts automatically, and retains drafts on unsafe paste or send failure', () => {
  const client = read('public/terminal.js');
  const source = client.slice(client.indexOf("pendingText.addEventListener"), client.indexOf('// Exposed only as local iframe state'));
  const handlers = {}, frames = [];
  const control = name => ({ disabled: false, addEventListener(type, fn) { handlers[name + ':' + type] = fn; } });
  const context = {
    pendingText: { ...control('text'), value: 'line one\nline two', focus() {} },
    pendingUndo: control('undo'),
    document: { getElementById: () => control('clear') },
    pendingHistory: { clear() {}, observe() {} }, pendingPanel: { hidden: false },
    transferringPending: false, terminalState: 'busy', WebSocket: { OPEN: 1 },
    ws: { readyState: 1, send(frame) { frames.push(JSON.parse(frame)); } },
    terminalDraftInput, term: { modes: { bracketedPasteMode: false }, focus() {} },
    updateScopedButtons() {}, scopedStatus: {}, showStatus() {}
  };
  runInNewContext(source, context);
  context.transferPending();
  assert.equal(frames.length, 0);
  context.terminalState = 'idle';
  context.transferPending();
  assert.equal(frames.length, 0);
  assert.equal(context.pendingText.value, 'line one\nline two');
  context.term.modes.bracketedPasteMode = true;
  const send = context.ws.send;
  context.ws.send = () => { throw Error('disconnected'); };
  context.transferPending();
  assert.equal(context.pendingText.value, 'line one\nline two');
  context.ws.send = send;
  context.transferPending();
  assert.deepEqual(frames, [{ type: 'input', data: '\x1b[200~line one\nline two\x1b[201~' }]);
  assert.equal(context.pendingText.value, '');
  assert.equal(context.pendingPanel.hidden, true);
  assert.equal(frames.some(frame => /\r|\x1b\[201~\r/.test(frame.data)), false, 'never submits');
  const client2 = read('public/terminal.js');
  assert.match(client2, /ready && pendingText\.value && !transferringPending && document\.activeElement !== pendingText/);
  assert.doesNotMatch(client2, /pendingInsert|pending-insert/);
});
