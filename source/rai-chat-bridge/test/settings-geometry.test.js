import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../public/terminal.css', import.meta.url), 'utf8');
const rule = selector => css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]+)'))?.[1] || '';
test('theme selector has two equal tracks independently of the three tabs', () => {
  assert.match(rule('.settings-theme-toggle'), /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(rule('.settings-tabs'), /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
});
test('provider controls share flex geometry without a Test OAuth override', () => {
  assert.match(rule('#settings-provider-actions button'), /flex: 1 1 0/);
  assert.doesNotMatch(rule('#settings-provider-actions #settings-test-provider'), /flex:/);
});
test('settings body reserves an outer scrollbar gutter with horizontal containment', () => {
  const body = rule('#settings-panel [role="tabpanel"]');
  assert.match(body, /scrollbar-gutter: stable/);
  assert.match(body, /overflow-x: hidden/);
  assert.match(body, /margin-right: calc\(4px - var\(--settings-padding\)\)/);
  assert.match(css, /--settings-padding: 8px/);
});
test('provider controls can shrink inside the narrow settings body', () => {
  assert.match(rule('#settings-provider-actions button'), /min-width: 0/);
  assert.match(rule('#settings-provider-actions button'), /overflow-wrap: anywhere/);
});
test('short panels share padding with the gutter extension and reserve editor focus space', () => {
  assert.match(rule('#settings-panel'), /padding: var\(--settings-padding\)/);
  const short = css.match(/@media \(max-height: 360px\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(short, /--settings-padding: 8px/);
  assert.match(short, /#settings-panel textarea \{ min-height: 64px; height: 64px; max-height: 64px;/);
  assert.match(rule('#settings-panel [role="tabpanel"]'), /scroll-padding: 4px/);
});

test('focus scrolling reserves the textarea below its first-line caret', () => {
  assert.match(rule('#settings-panel [role="tabpanel"]'), /scroll-padding-bottom: 140px/);
  const short = css.match(/@media \(max-height: 360px\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(short, /scroll-padding-bottom: 44px/);
});
