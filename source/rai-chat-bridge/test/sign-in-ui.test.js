import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const read = relative => readFileSync(fileURLToPath(new URL(relative, root)), 'utf8');

test('settings exposes a dedicated provider sign-in action', () => {
  const html = read('public/index.html');
  const client = read('public/terminal.js');

  assert.match(html, /id="settings-sign-in-provider"[^>]*>Sign in</);
  assert.match(client, /signInProviderBtn\.addEventListener\('click', startProviderSignIn\)/);
  assert.match(client, /type: 'sign_in'/);
  assert.match(client, /async function startProviderSignIn\(\)[\s\S]*await persistSettings\(\)/);
});

test('bridge replaces the assistant PTY with provider OAuth and restores it when sign-in exits', () => {
  const server = read('server.js');

  assert.match(server, /createProviderLoginSession/);
  assert.match(server, /function startSignIn\(\)/);
  assert.match(server, /grokAuthState\(\) === 'authenticated'/);
  assert.match(read('public/terminal.js'), /already_signed_in/);
  assert.match(server, /type === 'sign_in'/);
  assert.match(server, /type: 'signin_complete'/);
  assert.match(server, /start\(\);\s*\/\/ restore the normal assistant terminal/);
});
