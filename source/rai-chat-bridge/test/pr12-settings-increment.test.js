import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const js = readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/terminal.css', import.meta.url), 'utf8');

test('System uses live OS appearance while retaining explicit theme mode', () => {
  const functionText = js.slice(js.indexOf('function applyTheme('), js.indexOf('\nfunction settingsBody('));
  const stored = new Map();
  const buttons = ['dark','light','system'].map(theme => ({dataset:{theme}, classList:{toggle(){}},setAttribute(){}}));
  const context = {document:{documentElement:{dataset:{}}}, term:{options:{}}, terminalThemes:{dark:{id:'black'},light:{id:'white'}},
    localStorage:{setItem:(k,v)=>stored.set(k,v),getItem:k=>stored.get(k)}, THEME_KEY:'theme', themeButtons:buttons,
    systemAppearance:{matches:false}, window:{matchMedia:()=>({matches:false})}};
  vm.createContext(context);
  vm.runInContext(functionText, context);
  context.applyTheme('system');
  assert.equal(context.document.documentElement.dataset.theme, 'light');
  assert.equal(stored.get('theme'), 'system');
  context.systemAppearance.matches = true;
  context.applyTheme('system');
  assert.equal(context.document.documentElement.dataset.theme, 'dark');
  context.applyTheme('light');
  assert.equal(context.document.documentElement.dataset.theme, 'light');
  assert.equal(stored.get('theme'), 'light');
  context.applyTheme('dark');
  assert.equal(context.document.documentElement.dataset.theme, 'dark');
});

test('parked System selector retains saved-theme compatibility and accessible add/remove safeguards', () => {
  assert.doesNotMatch(html, /id="settings-theme-system"/);
  assert.match(html, /id="settings-theme-dark"[^>]*data-theme="dark"[^>]*>Black/);
  assert.match(html, /id="settings-theme-light"[^>]*data-theme="light"[^>]*>White/);
  const pane = html.slice(html.indexOf('id="settings-snippets"'), html.indexOf('id="settings-error"'));
  assert.ok(pane.indexOf('id="settings-add-snippet"') < pane.indexOf('id="snippet-list"'));
  assert.ok(pane.indexOf('id="snippet-delete"') < pane.indexOf('id="snippet-list"'));
  assert.match(html, /id="settings-add-snippet"[^>]*aria-label="Add snippet"/);
  assert.match(html, /id="snippet-delete"[^>]*aria-label="Delete selected snippet"/);
  assert.match(css, /#settings-global-prompt, #snippet-edit-prompt \{[^}]*font-size: 12px/s);
  assert.match(js, /Confirm delete/);
  assert.match(js, /delete draftSnippets\[selectedSnippetId\]/);
  assert.match(js, /systemAppearance\.addEventListener\('change'/);
});
