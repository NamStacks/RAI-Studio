import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { skillHint } from '../public/skill-hints.js';
import { summarizeNativeCli } from '../public/provider-status-display.js';

const source = readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/terminal.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
function functions(names, context) {
  vm.createContext(context);
  for (const name of names) {
    const from = source.indexOf(`function ${name}(`);
    assert.notEqual(from, -1, name);
    const start = source.lastIndexOf('\n', from);
    vm.runInContext(source.slice(start, source.indexOf('\n}', from) + 2), context);
  }
  return context;
}

test('persistSettings: an unreachable bridge says so and keeps the draft', async () => {
  const errors = [];
  const c = functions(['slimSnippets','persistSettings'], { settingsBody: () => ({ provider: 'claude', snippets: {} }), settingsRevision: 'r1',
    currentProvider: 'claude', wsSessionToken: 't', savedSettings: null, showStatus() {}, showSettingsError: e => errors.push(e),
    fetch: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(await c.persistSettings(), false);
  assert.match(errors[0], /not responding/);
  assert.doesNotMatch(errors[0], /Could not save settings/);
  assert.equal(c.settingsRevision, 'r1');
});

test('persistSettings: a stale session token after a bridge restart says so instead of a generic failure', async () => {
  const errors = [];
  const c = functions(['slimSnippets','persistSettings'], { settingsBody: () => ({ provider: 'claude', snippets: {} }), settingsRevision: 'r1',
    currentProvider: 'claude', wsSessionToken: 'old', savedSettings: null, showStatus() {}, showSettingsError: e => errors.push(e),
    fetch: async () => ({ ok: false, status: 401, json: async () => { throw new SyntaxError('unauthorized'); } }) });
  assert.equal(await c.persistSettings(), false);
  assert.match(errors[0], /restarted/);
  assert.match(errors[0], /Reload the Assistant pane/);
  assert.equal(c.settingsRevision, 'r1');
});

function conflictContext({ responses, refetch, draft = { provider: 'claude', globalPrompt: 'mine', snippets: {} }, saved = null }) {
  const errors = [], statuses = [], posted = [];
  const c = functions(['slimSnippets','persistSettings'], { settingsBody: () => structuredClone(draft), settingsRevision: 'old',
    currentProvider: 'claude', wsSessionToken: 't', savedSettings: saved, showStatus: s => statuses.push(s), showSettingsError: e => errors.push(e),
    fetchSettings: refetch,
    fetch: async (_url, options) => { posted.push(JSON.parse(options.body)); return responses.shift(); } });
  return { c, errors, statuses, posted };
}
const conflict = { ok: false, status: 409, json: async () => ({ error: 'Settings changed or revision missing; reload before saving. Draft retained.' }) };

test('persistSettings: a 409 takes the newest revision and saves the same draft again (Save always overwrites)', async () => {
  const f = conflictContext({ responses: [conflict, { ok: true, status: 200, json: async () => ({ provider: 'claude', settings_revision: 'saved' }) }],
    refetch: async () => ({ settings_revision: 'new' }) });
  assert.equal(await f.c.persistSettings(), true);
  assert.deepEqual(f.posted.map(body => body.expected_revision), ['old', 'new']);
  const { expected_revision: _a, ...first } = f.posted[0];
  const { expected_revision: _b, ...second } = f.posted[1];
  assert.deepEqual(second, first, 'the whole draft is sent again, not one field of it');
  assert.equal(first.globalPrompt, 'mine');
  assert.equal(f.c.settingsRevision, 'saved');
  assert.deepEqual(f.errors, [], 'no error is shown when the overwrite succeeds');
  assert.match(f.statuses.join(' '), /Your values replaced them/);
});

test('persistSettings: a conflict that never clears stops after three attempts and keeps the draft', async () => {
  const f = conflictContext({ responses: [conflict, conflict, conflict, conflict], refetch: async () => ({ settings_revision: 'newer' }) });
  assert.equal(await f.c.persistSettings(), false);
  assert.equal(f.posted.length, 3);
  assert.match(f.errors[0], /Settings keep changing elsewhere/);
});

test('persistSettings: a conflict whose refetch fails says the assistant is not responding', async () => {
  const f = conflictContext({ responses: [conflict], refetch: async () => { throw new Error('down'); } });
  assert.equal(await f.c.persistSettings(), false);
  assert.equal(f.posted.length, 1);
  assert.match(f.errors[0], /not responding/);
  assert.equal(f.c.settingsRevision, 'old');
});

function saveContext(overrides) {
  const errors = [];
  const c = functions(['saveSettings'], { settingsLoading: false, settingsSaving: false, settingsRevision: 'r1',
    validateGlobalPrompt() {}, validateSnippets() {}, globalPromptInput: { value: '' }, snippetInputValue: () => ({}),
    savedSettings: null, settingsSave: { disabled: false, focus() {} }, panel: { inert: false, setAttribute() {}, removeAttribute() {} },
    showSettingsError: e => errors.push(e), ...overrides });
  return { c, errors };
}

test('saveSettings: a save that persisted but could not finish updating does not claim the changes remain in the editor', async () => {
  const { c, errors } = saveContext({ persistSettings: async () => true, applySnippets() { throw new Error('boom'); },
    draftSnippets: {} });
  await c.saveSettings();
  assert.match(errors[0], /Saved, but the panel could not finish updating \(boom\)/);
  assert.doesNotMatch(errors[0], /remain in the editor/);
});

test('saveSettings: a failure before the save is persisted says the changes remain in the editor', async () => {
  const { c, errors } = saveContext({ persistSettings: async () => { throw new Error('boom'); } });
  await c.saveSettings();
  assert.match(errors[0], /Could not save settings \(boom\)/);
});

test('refreshProviderStatus: a failed check shows unknown chips and an unknown line, never checking or not installed', async () => {
  for (const fetch of [async () => ({ ok: false, json: async () => null }), async () => ({ ok: true, json: async () => ({}) }), async () => { throw new Error('down'); }]) {
    const lists = [];
    const status = { dataset: {}, textContent: '' };
    const c = functions(['renderProviderStatusUnknown', 'refreshProviderStatus'], { providerStatusEl: status,
      signInProviderBtn: { disabled: true }, testProviderBtn: { disabled: false }, providerSel: { value: 'claude' }, wsSessionToken: 't',
      fetch, renderProviderStatus() { throw new Error('must not render a status for a failed check'); },
      renderNativeCliList: value => lists.push(value) });
    await c.refreshProviderStatus();
    assert.deepEqual(lists, [null], 'null means unknown; undefined would mean still checking');
    assert.equal(status.dataset.state, 'unknown');
    assert.equal(status.textContent, 'Could not check sign-in.');
    assert.equal(c.signInProviderBtn.disabled, false);
  }
});

test('summarizeNativeCli: undefined is checking, null is unknown, a probe result is its own state', () => {
  assert.deepEqual(summarizeNativeCli(undefined), { authState: 'checking', text: 'Checking…' });
  assert.deepEqual(summarizeNativeCli(null), { authState: 'unknown', text: 'Unknown' });
  assert.deepEqual(summarizeNativeCli({ commandAvailable: true, authState: 'authenticated' }), { authState: 'authenticated', text: 'Signed in' });
  assert.deepEqual(summarizeNativeCli({ commandAvailable: true, authState: 'unauthenticated' }), { authState: 'unauthenticated', text: 'Sign in needed' });
  assert.deepEqual(summarizeNativeCli({ commandAvailable: false }), { authState: 'unavailable', text: 'Not installed' });
});

test('skill hints name the right provider', () => {
  assert.match(skillHint('grok', '').message, /^Grok Build/);
  assert.doesNotMatch(skillHint('grok', '/x').message, /OpenCode/);
  assert.match(skillHint('opencode', '').message, /^OpenCode/);
  assert.doesNotMatch(skillHint('something-else', '').message, /OpenCode/);
});

test('user-facing status text has no em dash and the exit banner names the provider', () => {
  assert.doesNotMatch(source.replace(/^\s*\/\/.*$/gm, ''), /showStatus\([^)]*—/);
  assert.match(source, /NATIVE_CLIS\[currentProvider\] \|\| 'The assistant'\} exited/);
  assert.doesNotMatch(source, /`claude exited/);
});

test('provider chips keep keyboard focus across a re-render', () => {
  assert.match(source, /focusedProvider/);
  assert.match(source, /\.focus\(\);\n\}/);
});

test('styles: error and install link readable on both themes; status line is a live region', () => {
  assert.match(css, /html\[data-theme="light"\] #settings-error \{ color: #b3261e; \}/);
  assert.match(css, /#settings-provider-status a \{ color: #6aa8ff/);
  assert.match(css, /html\[data-theme="light"\] #settings-provider-status a/);
  assert.match(html, /<div id="term-status" role="status" aria-live="polite" hidden>/);
});

test('Escape closes the panel, or backs out of the discard prompt', () => {
  const listeners = {};
  let focused = null, closed = 0;
  const confirm = { hidden: true };
  const c = { panel: { hidden: false, addEventListener: (type, fn) => { listeners[type] = fn; } }, gearBtn: { addEventListener() {} },
    settingsTabs: { general: { focus: () => { focused = 'general'; } } }, settingsSave: { focus: () => { focused = 'save'; } },
    document: { getElementById: () => confirm }, closePanel: () => { closed += 1; }, openPanel: async () => {} };
  vm.createContext(c);
  const from = source.indexOf('const focusSettings');
  vm.runInContext(source.slice(from, source.indexOf('\nproviderSel.addEventListener', from)), c);
  const press = key => { let prevented = false; listeners.keydown({ key, preventDefault: () => { prevented = true; } }); return prevented; };
  assert.equal(press('a'), false);
  assert.equal(closed, 0);
  assert.equal(press('Escape'), true);
  assert.equal(closed, 1);
  confirm.hidden = false;
  press('Escape');
  assert.equal(confirm.hidden, true, 'Escape on the discard prompt means keep editing');
  assert.equal(focused, 'save');
  assert.equal(closed, 1);
  c.panel.hidden = true;
  press('Escape');
  assert.equal(closed, 1, 'a hidden panel ignores Escape');
});

test('the Sign in button says Sign in again only when already signed in', async () => {
  const { resolveProviderStatusDisplay } = await import('../public/provider-status-display.js');
  const button = { textContent: 'Sign in', disabled: true };
  const c = functions(['renderProviderStatusUnknown', 'renderProviderStatus'], { resolveProviderStatusDisplay,
    providerStatusEl: { dataset: {}, appendChild() {}, set innerHTML(v) {}, textContent: '' }, signInProviderBtn: button,
    document: { createTextNode: text => text } });
  c.renderProviderStatus({ commandAvailable: true, authState: 'authenticated' }, 'claude');
  assert.equal(button.textContent, 'Sign in again');
  c.renderProviderStatus({ commandAvailable: true, authState: 'unauthenticated' }, 'claude');
  assert.equal(button.textContent, 'Sign in');
  c.renderProviderStatus({ commandAvailable: true, authState: 'authenticated' }, 'claude');
  c.renderProviderStatusUnknown();
  assert.equal(button.textContent, 'Sign in');
});

test('xterm lifts unreadable color pairs and the named colors stay readable on their theme background', () => {
  const luminance = hex => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  assert.match(source, /new Terminal\(\{[\s\S]*minimumContrastRatio: 4\.5,[\s\S]*theme: terminalThemes\[savedTheme\]/,
    'black on black and white on white are lifted by xterm, not by retuning single palette slots');
  const themes = vm.runInNewContext(source.slice(source.indexOf('{\n  dark: {'), source.indexOf('};\ndocument.documentElement.dataset.theme') + 1)
    .replace(/^\{/, '({').replace(/\}$/, '})'));
  for (const [name, theme] of Object.entries(themes)) {
    assert.ok(ratio(theme.foreground, theme.background) >= 7, `${name} foreground`);
    for (const color of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan'])
      assert.ok(ratio(theme[color], theme.background) >= 3, `${name} ${color} ${theme[color]} on ${theme.background}`);
  }
});

test('snippet validation errors are plain sentences without internal ids', async () => {
  const { validateSnippets } = await import('../public/scoped-guidance.js');
  const messages = [];
  for (const value of [{ writing: { name: '', prompt: 'x' } }, { writing: { name: 'ok', prompt: '' } },
    { writing: { name: 'a' } }, { writing: { name: 'ok', prompt: 'x\ny' } },
    { writing: { name: 'Same', prompt: 'x' }, analysis: { name: 'same', prompt: 'y' } }]) {
    try { validateSnippets(value); } catch (error) { messages.push(error.message); }
  }
  assert.equal(messages.length, 5);
  for (const message of messages) {
    assert.doesNotMatch(message, /writing|analysis|s-[a-f0-9]/, message);
    assert.doesNotMatch(message, /code points|—/, message);
    assert.match(message, /^[A-Z].*\.$/, message);
  }
});

test('Settings panel basics: dialog role, readable placeholders, spoken snippet count, no dead active-model code', () => {
  assert.match(html, /<div id="settings-panel" role="dialog" aria-label="Assistant settings" hidden>/);
  assert.match(css, /#settings-panel ::placeholder \{ color: rgba\(229, 229, 231, 0\.62\); opacity: 1; \}/);
  assert.match(css, /html\[data-theme="light"\] #settings-panel ::placeholder \{ color: #5c5c61; \}/);
  assert.match(css, /\.sr-only \{/);
  assert.match(source, /`\$\{ids\.length\} of 5 snippets`/);
  assert.doesNotMatch(source, /activeModelEl|settings-active-model/);
});

test('persistSettings: a conflict rebuilds the name-only snippets against the newest settings, so Save still wins', async () => {
  const draft = { provider: 'claude', globalPrompt: 'mine', snippets: {
    gone: { name: 'Gone', prompt: 'same as before' },
    edited: { name: 'Edited', prompt: 'my text' },
    stable: { name: 'Stable', prompt: 'unchanged' },
    fresh: { name: 'Fresh', prompt: 'new' } } };
  const saved = { snippets: { gone: { prompt: 'same as before' }, edited: { prompt: 'my text' }, stable: { prompt: 'unchanged' } } };
  const f = conflictContext({ draft, saved, responses: [conflict, { ok: true, status: 200, json: async () => ({ settings_revision: 'saved' }) }],
    refetch: async () => ({ settings_revision: 'new', snippets: { edited: { prompt: 'their text' }, stable: { prompt: 'unchanged' } } }) });
  assert.equal(await f.c.persistSettings(), true);
  assert.deepEqual(f.posted[0].snippets, { gone: { name: 'Gone' }, edited: { name: 'Edited' }, stable: { name: 'Stable' }, fresh: { name: 'Fresh', prompt: 'new' } },
    'first try sends only what changed against the pane baseline');
  assert.deepEqual(f.posted[1].snippets, { gone: { name: 'Gone', prompt: 'same as before' }, edited: { name: 'Edited', prompt: 'my text' },
    stable: { name: 'Stable' }, fresh: { name: 'Fresh', prompt: 'new' } },
    'a snippet the newest settings dropped or changed is sent in full, so the draft wins instead of failing or keeping their text');
});

test('persistSettings: a refetch after a conflict names the real problem', async () => {
  for (const [status, pattern] of [[401, /restarted.*Reload the Assistant pane/], [503, /native settings are unavailable/], [undefined, /not responding/]]) {
    const f = conflictContext({ responses: [conflict], refetch: async () => { throw Object.assign(new Error('x'), { status }); } });
    assert.equal(await f.c.persistSettings(), false);
    assert.match(f.errors[0], pattern, String(status));
    assert.equal(f.c.settingsRevision, 'old');
  }
});

test('persistSettings: the overwrite and fallback notices are handed to the caller so a later status cannot hide them', async () => {
  const f = conflictContext({ responses: [conflict, { ok: true, status: 200, json: async () => ({ settings_revision: 'saved', fallback: true, message: 'Unknown model alias.' }) }],
    refetch: async () => ({ settings_revision: 'new' }) });
  const outcome = {};
  assert.equal(await f.c.persistSettings(outcome), true);
  assert.equal(outcome.notice, 'Settings had changed elsewhere. Your values replaced them. Unknown model alias.');
  const quiet = conflictContext({ responses: [{ ok: true, status: 200, json: async () => ({ settings_revision: 'saved' }) }], refetch: async () => ({}) });
  const none = {};
  assert.equal(await quiet.c.persistSettings(none), true);
  assert.equal(none.notice, '');
});

test('saveSettings: the overwrite notice survives the restart-pending message', async () => {
  const statuses = [];
  const { c } = saveContext({ persistSettings: async outcome => { outcome.notice = 'Settings had changed elsewhere. Your values replaced them.'; return true; },
    draftSnippets: {}, applySnippets() {}, savedGlobalPrompt: '', settingsBody: () => ({}), applyFontSize() {}, applyTheme() {}, fontSizeSel: { value: '12' },
    providerSel: { value: 'codex' }, savedAppearance: {}, draftThemeMode: 'dark', closePanelDiscard() {}, restartPendingBtn: { hidden: true },
    sessionStorage: { setItem() {} }, updateScopedButtons() {}, restartConfirmPending: false, showStatus: s => statuses.push(s),
    savedSettings: { provider: 'claude', globalPrompt: '' } });
  await c.saveSettings();
  assert.match(statuses.at(-1), /^Settings had changed elsewhere\. Your values replaced them\. Settings saved; restart pending\./);
});

test('saveSettings: a failed save puts keyboard focus back where it was', async () => {
  const calls = [];
  const field = { isConnected: true, disabled: false, focus: () => calls.push('field') };
  const { c } = saveContext({ persistSettings: async () => false,
    settingsSave: { disabled: false, ownerDocument: { activeElement: field }, focus: () => calls.push('save') },
    panel: { hidden: false, inert: false, setAttribute() {}, removeAttribute() {} } });
  await c.saveSettings();
  assert.deepEqual(calls, ['field']);
  const lost = saveContext({ persistSettings: async () => false,
    settingsSave: { disabled: false, ownerDocument: { activeElement: { isConnected: false, focus: () => calls.push('gone') } }, focus: () => calls.push('save') },
    panel: { hidden: false, inert: false, setAttribute() {}, removeAttribute() {} } });
  await lost.c.saveSettings();
  assert.deepEqual(calls, ['field', 'save'], 'a control that left the page sends focus to Save');
});

test('Escape does nothing while an input method is composing text', () => {
  const listeners = {};
  let closed = 0;
  const c = { panel: { hidden: false, addEventListener: (type, fn) => { listeners[type] = fn; } }, gearBtn: { addEventListener() {} },
    settingsTabs: { general: { focus() {} } }, settingsSave: { focus() {} }, document: { getElementById: () => ({ hidden: true }) },
    closePanel: () => { closed += 1; }, openPanel: async () => {} };
  vm.createContext(c);
  const from = source.indexOf('const focusSettings');
  vm.runInContext(source.slice(from, source.indexOf('\nproviderSel.addEventListener', from)), c);
  const press = event => { let prevented = false; listeners.keydown({ ...event, preventDefault: () => { prevented = true; } }); return prevented; };
  assert.equal(press({ key: 'Escape', isComposing: true }), false);
  assert.equal(press({ key: 'Escape', keyCode: 229 }), false);
  assert.equal(closed, 0);
  assert.equal(press({ key: 'Escape' }), true);
  assert.equal(closed, 1);
});

test('the sign-in label is reset while a new status check runs, and focus is not pulled out of Settings', () => {
  assert.match(source, /signInProviderBtn\.textContent = 'Sign in';\n  signInProviderBtn\.disabled = true;/);
  assert.equal((source.match(/if \(panel\.hidden\) term\.focus\(\);/g) || []).length, 2, 'transfer and reconnect leave focus alone while Settings is open');
  assert.match(source, /const wasHidden = panel\.hidden;\n  void openPanel\(\)\.then\(\(\) => \{ if \(wasHidden\) focusSettings\(\);/);
});

test('light theme keeps keyboard focus, the selected snippet and inactive labels visible', () => {
  assert.match(css, /html\[data-theme="light"\] #settings-panel input:focus,\n[^}]*#settings-panel textarea:focus[^}]*box-shadow/);
  assert.match(css, /html\[data-theme="light"\] #snippet-list button\[aria-selected="true"\] \{ border-color: #2f6fed;/);
  assert.match(css, /#settings-save:hover \{ background: #2a63d6 !important; \}/);
  assert.match(css, /body:has\(#restart-pending:not\(\[hidden\]\)\) #scoped-guidance \{ padding-right: 190px; \}/);
});
