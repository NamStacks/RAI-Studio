import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
function startupContext(overrides = {}) {
  const writes = [];
  let resolveSettings;
  const context = {
    fetchSettings: () => new Promise(resolve => { resolveSettings = resolve; }),
    currentProvider: 'claude', applySnippets(value) { context.loadedSnippets = value; },
    settingsReadGeneration: 0, settingsLoading: false, settingsSaving: false,
    panel: { hidden: true }, draftThemeMode: 'dark',
    document: { documentElement: { dataset: { theme: 'dark' } } },
    term: { options: { fontSize: 10 } }, terminalThemes: { dark: { id: 'black' }, light: { id: 'white' } },
    localStorage: { setItem: (...args) => writes.push(args) }, THEME_KEY: 'theme', FONT_SIZE_KEY: 'font',
    themeButtons: [], systemAppearance: { matches: false }, fit: { fit() {} }, sendResize() {},
    ...overrides
  };
  vm.createContext(context);
  const from = source.indexOf('function applyFontSize(');
  const to = source.indexOf('\nfunction settingsBody(', from);
  vm.runInContext(source.slice(from, to), context);
  const startup = source.match(/fetchSettings\(\)\.then\(cfg => [\s\S]*?\)\.catch\(\(\) => \{\}\);/);
  assert.ok(startup, 'production startup settings read exists');
  vm.runInContext(startup[0], context);
  return { context, writes, resolveSettings };
}

for (const fontSize of [16, 18]) {
  test(`startup canonical light/${fontSize} replaces stale origin-local appearance`, async () => {
    const { context, writes, resolveSettings } = startupContext();
    resolveSettings({ provider: 'codex', snippets: {}, theme: 'light', fontSize });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.document.documentElement.dataset.theme, 'light');
    assert.equal(context.term.options.fontSize, fontSize);
    assert.equal(context.draftThemeMode, 'light');
    assert.equal(context.currentProvider, 'codex');
    assert.deepEqual(writes, [], 'canonical read does not persist preview/local settings');
  });
}
test('startup resolves canonical system theme', async () => {
  const { context, resolveSettings } = startupContext();
  resolveSettings({ provider: 'codex', snippets: {}, theme: 'system', fontSize: 12 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.document.documentElement.dataset.theme, 'light');
  assert.equal(context.draftThemeMode, 'system');
});
test('late startup read cannot overwrite Settings preview or a newer completed transaction', async () => {
  const { context, writes, resolveSettings } = startupContext();
  context.settingsReadGeneration = 1;
  context.panel.hidden = false;
  context.draftThemeMode = 'light';
  context.applyFontSize(18, { persist: false });
  context.applyTheme('light', { persist: false });
  resolveSettings({ provider: 'codex', snippets: {}, theme: 'dark', fontSize: 10 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.term.options.fontSize, 18);
  assert.equal(context.document.documentElement.dataset.theme, 'light');
  assert.equal(context.draftThemeMode, 'light');
  assert.equal(context.currentProvider, 'claude');
  assert.deepEqual(writes, []);
});
test('font selector round-trips every supported size into the production Save payload', () => {
  const group = html.match(/settings-fontsize-toggle[\s\S]*?<input id="settings-fontsize"/)[0];
  assert.doesNotMatch(html, /<select/);
  const values = [...group.matchAll(/data-font-size="(\d+)"/g)].map(match => Number(match[1]));
  assert.deepEqual(values, [10, 12, 14]);
  const context = { providerSel: { value: 'codex' }, globalPromptInput: { value: 'unrelated edit' },
    snippetInputValue: () => ({}), autoApprovalInput: { checked: true }, caffeinateInput: { checked: true },
    draftThemeMode: 'light', fontSizeSel: { value: '' } };
  vm.createContext(context);
  const from = source.indexOf('function settingsBody(');
  const to = source.indexOf('\nasync function persistSettings(', from);
  vm.runInContext(source.slice(from, to), context);
  for (const size of values) {
    context.fontSizeSel.value = String(size);
    assert.equal(context.settingsBody().fontSize, size);
    assert.equal(context.settingsBody().globalPrompt, 'unrelated edit');
  }
});

for (const savedSize of [10, 12, 14, 16, 18]) {
  test(`Settings preserves saved ${savedSize} through unrelated Save without new default choices`, () => {
    const buttons = [10, 12, 14].map(size => ({ dataset: { fontSize: String(size) }, classList: { toggle() {} }, setAttribute() {}, remove() {} }));
    const group = {
      querySelector: () => buttons.find(button => button.dataset.savedFontSize) || null,
      querySelectorAll: () => buttons,
      append(button) { button.remove = () => buttons.splice(buttons.indexOf(button), 1); button.classList = { toggle() {} }; button.setAttribute = () => {}; buttons.push(button); }
    };
    const context = { fontGroup: group, fontSizeSel: { value: '' }, document: { createElement: () => ({ dataset: {} }) },
      providerSel: { value: 'codex' }, globalPromptInput: { value: 'unrelated edit' },
      snippetInputValue: () => ({}), caffeinateInput: { checked: true }, draftThemeMode: 'system' };
    vm.createContext(context);
    const start = source.indexOf('function selectSavedFontSize(');
    const end = source.indexOf('\nasync function openPanel(', start);
    assert.ok(start >= 0 && end > start);
    vm.runInContext(source.slice(start, end), context);
    const saveStart = source.indexOf('function settingsBody(');
    const saveEnd = source.indexOf('\nasync function persistSettings(', saveStart);
    vm.runInContext(source.slice(saveStart, saveEnd), context);
    context.selectSavedFontSize(savedSize);
    assert.equal(context.settingsBody().fontSize, savedSize);
    assert.equal(context.settingsBody().theme, 'system');
    assert.equal(context.settingsBody().globalPrompt, 'unrelated edit');
    assert.equal(context.settingsBody().saveOnEdit, true);
    assert.deepEqual(buttons.map(button => Number(button.dataset.fontSize)),
      savedSize > 14 ? [10, 12, 14, savedSize] : [10, 12, 14]);
    context.selectSavedFontSize(10);
    assert.deepEqual(buttons.map(button => Number(button.dataset.fontSize)), [10, 12, 14]);
    assert.equal(context.settingsBody().fontSize, 10);
    assert.match(source, /selectSavedFontSize\(cfg\.fontSize \|\| 10\)/);
  });
}

