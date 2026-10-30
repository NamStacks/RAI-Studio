import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/terminal.css', import.meta.url), 'utf8');
const js = readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');

test('settings copy describes save now and explicit idle restart without claiming provider bypass', () => {
  assert.match(html, /Save stores changes; use Restart Assistant when idle/);
  assert.doesNotMatch(html, /settings-auto-approval|Off restores RAI approval prompts/);
  assert.match(html, /Valid RAI tool actions are approved automatically/);
  assert.doesNotMatch(js, /autoApprovalInput|settings-auto-approval/);
  assert.match(css, /#settings-panel \.settings-hint\s*\{[^}]*font-size: 11px/);
  assert.doesNotMatch(css, /settings-auto-approval-hint/);
  assert.match(html, /Native CLI permissions remain unchanged/);
  assert.doesNotMatch(html, /RAI saving|settings-save-on-edit|<select/);
  assert.match(html, /id="settings-rai-policy-hint"[^>]*>Valid RAI tool actions are approved automatically\. Native CLI permissions remain unchanged\.</);
  assert.doesNotMatch(html, /Saving restarts this Assistant session|RAI sandboxes native file tools/);
  assert.match(html, /id="settings-save"[^>]*>Save changes/);
});

test('tab and listbox keyboard selection remain accessible without 11px nowrap clipping', () => {
  assert.match(html, /id="snippet-list" role="listbox"/);
  assert.match(js, /button\.setAttribute\('role', 'option'\)/);
  assert.match(js, /button\.tabIndex = id === selectedSnippetId \? 0 : -1/);
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) assert.ok(js.includes(key));
  assert.match(css, /\.settings-tabs\s*\{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /white-space: normal; overflow-wrap: anywhere/);
  assert.match(css, /@media \(max-height: 360px\)/);
  assert.match(css, /#scoped-shortcuts \{[^}]*flex-wrap: wrap[^}]*min-width: 0/s);
});

test('light/dark draft queueing and restart controls insert automatically without submitting', () => {
  for (const selector of ['#restart-pending', '#scoped-guidance', '#scoped-guidance button']) {
    assert.ok(css.includes(`html[data-theme="light"] ${selector}`), selector);
  }
  assert.match(html, /id="pending-undo"/);
  assert.match(html, /inserts automatically when the assistant is ready/);
  assert.doesNotMatch(html, /id="pending-insert"/);
  assert.match(js, /PendingDraftHistory/);
  assert.match(html, /Nothing is sent until you press Enter/);
  assert.match(js, /restartPendingBtn\.disabled = !\['idle', 'drafting'\]\.includes\(terminalState\)/);
  assert.match(js, /Restart replaces only this Assistant session/);
  assert.match(js, /ws\.send\(JSON\.stringify\(\{ type: 'input', data: input \}\)\)/);
});

test('legacy GWT settings has no approval control and submits fixed compatibility true', () => {
  const java = readFileSync(new URL('../../source/src/gwt/src/org/rstudio/studio/client/workbench/views/chat/RaiAssistantSettingsDialog.java', import.meta.url), 'utf8');
  assert.doesNotMatch(java, /autoApproveReadOnlyCheckbox_|raiAutoApproveReadOnlyButton|autoApproveReadOnly_/);
  assert.match(java.replace(/\/\/[^\n]*/g, ''), /boolean getAutoApproveReadOnly\(\)\s*\{\s*return true;/);
  assert.match(java, /new Input\(providerSelect_\.getValue\(\), caffeinateCheckbox_\.getValue\(\)\)/);
});


test('companion instructions do not resurrect a retired approval preference', () => {
  const prompt = readFileSync(new URL('../prompts/RAI-Assistant.md', import.meta.url), 'utf8');
  assert.doesNotMatch(prompt, /Full Auto|user disabled auto-approval|current auto-approval setting/);
});
