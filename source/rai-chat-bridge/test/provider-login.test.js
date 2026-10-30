import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProviderLoginSession, providerLoginArgs } from '../provider-login.js';

test('provider sign-in uses the documented interactive OAuth command for each supported provider', () => {
  assert.deepEqual(providerLoginArgs('codex'), ['login']);
  assert.deepEqual(providerLoginArgs('claude'), ['auth', 'login']);
  assert.deepEqual(providerLoginArgs('opencode'), ['auth', 'login']);
  assert.deepEqual(providerLoginArgs('grok'), ['login', '--device-auth']);
  assert.equal(providerLoginArgs('unknown'), null);
});

test('provider sign-in launches an interactive PTY with bridge secrets scrubbed', () => {
  const calls = [];
  const term = {};
  const session = createProviderLoginSession({
    provider: 'codex',
    profile: { command: 'codex' },
    cwd: '/tmp/project',
    env: {
      PATH: '/usr/bin',
      RAI_BRIDGE_TOKEN: 'bridge-secret',
      RAI_OWNER_TOKEN: 'owner-secret'
    },
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return term;
    },
    resolve: command => command
  });

  assert.equal(session, term);
  assert.deepEqual(calls, [{
    command: 'codex',
    args: ['login'],
    options: {
      name: 'xterm-256color', cols: 120, rows: 40, cwd: '/tmp/project', encoding: null,
      env: { PATH: '/usr/bin', TERM: 'xterm-256color' }
    }
  }]);
});

test('provider sign-in rejects unsupported providers without spawning a shell', () => {
  assert.throws(() => createProviderLoginSession({
    provider: 'unknown', profile: { command: 'unknown' }, spawn: () => {
      throw new Error('must not spawn');
    }
  }), /does not support browser-terminal sign-in/);
});
