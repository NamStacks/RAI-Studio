import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { resolveEffortInput } from '../public/effort.js';
import { NATIVE_CLIS } from '../public/provider-status-display.js';
import { terminalDraftInput } from '../public/scoped-guidance.js';

const source = readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');

function slice(from, to) {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `source has ${from}`);
  const end = source.indexOf(to, start);
  assert.notEqual(end, -1, `source has ${to} after ${from}`);
  return source.slice(start, end);
}

class FakeSocket {
  static OPEN = 1;
  static instances = [];
  constructor() { this.readyState = 0; this.sent = []; FakeSocket.instances.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
}
FakeSocket.CONNECTING = 0;
FakeSocket.CLOSED = 3;

function harness({ bracketedPasteMode = true } = {}) {
  FakeSocket.instances.length = 0;
  const posted = [];
  const writes = [];
  const statuses = [];
  const termCalls = { reset: 0, clear: 0 };
  let dataHandler = null;
  const context = {
    URL, queueMicrotask, WebSocket: FakeSocket, NATIVE_CLIS, terminalDraftInput,
    location: { protocol: 'http:', host: 'localhost:1' },
    wsSessionToken: 'token',
    window: { parent: { postMessage: (message) => posted.push(JSON.parse(JSON.stringify(message))) } },
    document: { activeElement: null },
    setTimeout: () => 0,
    currentProvider: 'claude',
    providersConfig: {},
    fit: { fit() {} },
    panel: { hidden: true },
    pendingText: { value: '' },
    pendingUndo: {},
    pendingPanel: { hidden: true },
    scopedStatus: { textContent: '' },
    restartPendingBtn: {},
    pendingHistory: { canUndo: false, clear() {} },
    term: {
      modes: { bracketedPasteMode },
      reset() { termCalls.reset++; }, clear() { termCalls.clear++; }, focus() {}, cols: 80, rows: 24,
      write: (bytes, callback) => writes.push({ bytes, callback }),
      onData: (handler) => { dataHandler = handler; }
    },
    showStatus: (text) => statuses.push(text),
    hideStatus() {},
    renderRunInspector() {},
    refreshProviderStatus() {}
  };
  vm.createContext(context);
  vm.runInContext(slice('let ws;', 'const shortcutsEl'), context);
  vm.runInContext('let transferringPending = false;', context);
  vm.runInContext(slice('function updateScopedButtons()', "restartPendingBtn.addEventListener('click'"), context);
  vm.runInContext(slice('function draftErrorText(', "pendingText.addEventListener('blur'"), context);
  vm.runInContext('function sendResize() {}', context);
  vm.runInContext(slice('function composerGone(', '// keystrokes -> pty'), context);
  const onData = source.match(/term\.onData\(data => \{[\s\S]*?\n\}\);/);
  assert.ok(onData, 'term.onData handler exists');
  vm.runInContext(onData[0], context);
  vm.runInContext('connect();', context);
  const ws = FakeSocket.instances[0];
  ws.readyState = FakeSocket.OPEN;
  ws.onopen();
  const message = (frame) => ws.onmessage({ data: JSON.stringify(frame) });
  const get = (name) => vm.runInContext(name, context);
  return { context, ws, posted, writes, statuses, termCalls, message, get, typeKey: (data) => dataHandler(data) };
}

test('exit leaves no live composer, ignores a stale idle frame and keeps the staged draft', () => {
  const h = harness();
  h.message({ type: 'status', state: 'idle' });
  assert.equal(h.get('window.__raiComposerReady'), true);
  h.context.pendingText.value = 'Review this';
  h.message({ type: 'exit', exitCode: 0 });
  assert.equal(h.get('terminalState'), 'unknown');
  assert.equal(h.get('window.__raiComposerReady'), false);
  assert.deepEqual(h.posted.at(-1), { type: 'assistant-status', state: '' });
  h.message({ type: 'status', state: 'idle' });
  assert.equal(h.get('terminalState'), 'unknown');
  vm.runInContext('transferPending()', h.context);
  assert.deepEqual(h.ws.sent.filter(frame => frame.type === 'input'), []);
  assert.equal(h.context.pendingText.value, 'Review this');
});

for (const type of ['launch_failed', 'profile_error', 'signin_started']) {
  test(`${type} clears the composer state until a new connection`, () => {
    const h = harness();
    h.message({ type: 'status', state: 'idle' });
    h.context.pendingText.value = 'Draft';
    h.message({ type });
    if (type === 'signin_started') {
      assert.equal(h.termCalls.reset, 1);
      assert.equal(h.termCalls.clear, 0);
    }
    assert.equal(h.get('terminalState'), 'unknown');
    assert.equal(h.get('window.__raiComposerReady'), false);
    assert.deepEqual(h.posted.at(-1), { type: 'assistant-status', state: '' });
    h.message({ type: 'status', state: 'idle' });
    assert.equal(h.get('terminalState'), 'unknown');
    vm.runInContext('transferPending()', h.context);
    assert.deepEqual(h.ws.sent.filter(frame => frame.type === 'input'), []);
    assert.equal(h.context.pendingText.value, 'Draft');
    h.ws.onopen();
    h.message({ type: 'status', state: 'idle' });
    assert.equal(h.get('terminalState'), 'idle');
  });
}

for (const type of ['bridge_config_error', 'signin_unavailable']) {
  test(`${type} shows its status and leaves the live composer alone`, () => {
    const h = harness();
    h.message({ type: 'status', state: 'idle' });
    h.message({ type });
    assert.equal(h.statuses.length > 0, true);
    assert.equal(h.get('terminalState'), 'idle');
    h.message({ type: 'status', state: 'drafting' });
    assert.equal(h.get('terminalState'), 'drafting');
  });
}

test('already_signed_in re-enables status frames after an exit', () => {
  const h = harness();
  h.message({ type: 'exit', exitCode: 0 });
  h.message({ type: 'already_signed_in' });
  h.message({ type: 'status', state: 'idle' });
  assert.equal(h.get('terminalState'), 'idle');
});

test('restarted clears the composer state and accepts the new session status frame', () => {
  const h = harness();
  h.message({ type: 'status', state: 'idle' });
  h.message({ type: 'restarted' });
  assert.equal(h.get('terminalState'), 'unknown');
  assert.equal(h.get('window.__raiComposerReady'), false);
  h.message({ type: 'status', state: 'idle' });
  assert.equal(h.get('terminalState'), 'idle');
});

for (const type of ['exit', 'launch_failed']) {
  test(`${type} then restarted lets the new session status frame through`, () => {
    const h = harness();
    h.message({ type: 'status', state: 'idle' });
    h.message({ type });
    h.message({ type: 'status', state: 'idle' });
    assert.equal(h.get('terminalState'), 'unknown');
    h.message({ type: 'restarted' });
    h.message({ type: 'status', state: 'idle' });
    assert.equal(h.get('terminalState'), 'idle');
  });
}

test('signin_complete lets the status frame of the restarted assistant through', () => {
  const h = harness();
  h.message({ type: 'status', state: 'idle' });
  h.message({ type: 'signin_started' });
  h.message({ type: 'status', state: 'idle' });
  assert.equal(h.get('terminalState'), 'unknown');
  h.message({ type: 'signin_complete' });
  h.message({ type: 'status', state: 'idle' });
  assert.equal(h.get('terminalState'), 'idle');
});

test('exit banner shows the signal and does not promise a reconnect that does not happen', () => {
  const h = harness();
  h.message({ type: 'exit', exitCode: null, signal: 9 });
  const banner = h.statuses.at(-1);
  assert.match(banner, /signal 9/);
  assert.match(banner, /Press any key/);
  assert.doesNotMatch(banner, /Reconnecting for a fresh session/);
});

test('terminal replies to replayed queries are not typed into the live provider', () => {
  const h = harness();
  h.message({ type: 'replay_start' });
  h.ws.onmessage({ data: new Uint8Array([0x1b, 0x5b, 0x63]).buffer });
  h.typeKey('\x1b[?1;2c');
  assert.deepEqual(h.ws.sent.filter(frame => frame.type === 'input'), []);
  h.writes.at(-1).callback();
  h.typeKey('a');
  assert.deepEqual(h.ws.sent.filter(frame => frame.type === 'input'), [{ type: 'input', data: 'a' }]);
});

test('a dropped socket during replay does not leave typing blocked', () => {
  const h = harness();
  h.message({ type: 'replay_start' });
  h.typeKey('a');
  assert.deepEqual(h.ws.sent.filter(frame => frame.type === 'input'), []);
  h.ws.onclose();
  h.ws.onopen();
  h.typeKey('b');
  assert.deepEqual(h.ws.sent.filter(frame => frame.type === 'input'), [{ type: 'input', data: 'b' }]);
});

test('the paste-mode failure and the control-character failure report different causes', () => {
  const h = harness({ bracketedPasteMode: false });
  h.message({ type: 'status', state: 'idle' });
  h.context.pendingText.value = 'line one\nline two';
  vm.runInContext('transferPending()', h.context);
  assert.match(h.statuses.at(-1), /multi-line paste/);
  assert.doesNotMatch(h.statuses.at(-1), /unsafe terminal control text/);
  h.context.pendingText.value = 'bad\x07text';
  vm.runInContext('transferPending()', h.context);
  assert.match(h.statuses.at(-1), /unsafe terminal control text/);
});

test('sign-in does not send on a socket that closed while settings were saving', async () => {
  const h = harness();
  const calls = [];
  Object.assign(h.context, {
    signInProviderBtn: { disabled: false },
    globalPromptInput: { value: '' },
    draftSnippets: {}, savedSettings: null, draftThemeMode: 'dark', fontSizeSel: { value: '10' },
    validateGlobalPrompt() {}, validateSnippets() {}, showSettingsError() {},
    persistSettings: async () => { h.ws.readyState = FakeSocket.CLOSED; return true; },
    applySnippets: () => calls.push('applySnippets'), applyFontSize() {}, applyTheme() {},
    closePanelDiscard: () => calls.push('closePanel')
  });
  vm.runInContext(slice('async function startProviderSignIn()', '\nfunction selectSavedFontSize('), h.context);
  await vm.runInContext('startProviderSignIn()', h.context);
  assert.deepEqual(h.ws.sent.filter(frame => frame.type === 'sign_in'), []);
  assert.deepEqual(calls, []);
  assert.equal(h.context.signInProviderBtn.disabled, false);
  assert.match(h.statuses.at(-1), /press Sign in again/);
});

test('an effort value the provider advertises exactly wins over its alias', () => {
  assert.equal(resolveEffortInput('max', ['low', 'high', 'max', 'ultra']), 'max');
  assert.equal(resolveEffortInput('max', ['low', 'high', 'ultra']), 'ultra');
  assert.equal(resolveEffortInput('ultra', ['low', 'high', 'max']), null);
});
