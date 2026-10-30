import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolveEffortInput } from '../public/effort.js';

test('typed effort aliases resolve only to levels supported by the active provider', () => {
  assert.equal(resolveEffortInput(' HIGH ', ['low', 'medium', 'high']), 'high');
  assert.equal(resolveEffortInput('max', ['low', 'medium', 'high', 'ultra']), 'ultra');
  assert.equal(resolveEffortInput('max', ['low', 'medium', 'high', 'max']), 'max');
  assert.equal(resolveEffortInput('ultra', ['low', 'medium', 'high', 'max']), null);
  assert.equal(resolveEffortInput('turbo', ['low', 'medium', 'high']), null);
});

test('blank typed effort selects Auto and persists no provider override', () => {
  assert.equal(resolveEffortInput('', ['low', 'medium', 'high']), '');
  assert.equal(resolveEffortInput('   ', ['low', 'medium', 'high']), '');
});

test('settings UI saves the selected provider and editor fields without model/effort overrides', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');

  assert.match(html, /<input id="settings-provider" type="hidden"/);
  assert.doesNotMatch(html.slice(html.indexOf('id="settings-general"'), html.indexOf('id="settings-global"')), /<select/);
  const body = script.slice(script.indexOf('function settingsBody()'), script.indexOf('async function persistSettings()'));
  assert.match(body, /return \{ provider: providerSel\.value, globalPrompt:/);
  assert.match(body, /autoApproveReadOnly: true/);
  assert.doesNotMatch(body, /effort:|model:/);
});
