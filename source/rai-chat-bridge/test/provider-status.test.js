import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerStatusForSettings } from '../provider-status.js';

test('provider status reports command availability and authenticated OAuth state without CLI output', async () => {
  const calls = [];
  const statuses = await providerStatusForSettings({
    providers: {
      claude: { command: 'claude', authMode: 'subscription' },
      codex: { command: 'codex', authMode: 'subscription' }
    }
  }, {
    commandExists: command => command !== 'claude',
    run: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: 'secret-token', stderr: 'private@example.com' };
    }
  });

  assert.deepEqual(statuses, {
    claude: { commandAvailable: false, authState: 'unavailable', authMode: 'subscription' },
    codex: { commandAvailable: true, authState: 'authenticated', authMode: 'subscription' }
  });
  assert.deepEqual(calls, [{
    command: 'codex', args: ['login', 'status'],
    options: { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024, windowsHide: true }
  }]);
  assert.equal(JSON.stringify(statuses).includes('secret-token'), false);
  assert.equal(JSON.stringify(statuses).includes('private@example.com'), false);
});

test('provider status maps Claude auth failures to unauthenticated and bounds the CLI command', async () => {
  const calls = [];
  const statuses = await providerStatusForSettings({
    providers: { claude: { command: 'claude' } }
  }, {
    commandExists: () => true,
    run: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 1, stdout: 'not logged in' };
    }
  });

  assert.deepEqual(statuses, {
    claude: { commandAvailable: true, authState: 'unauthenticated', authMode: 'subscription' }
  });
  assert.deepEqual(calls, [{
    command: 'claude', args: ['auth', 'status'],
    options: { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024, windowsHide: true }
  }]);
});

test('provider status never runs an auth command for explicit API mode', async () => {
  const statuses = await providerStatusForSettings({
    providers: { codex: { command: 'codex', authMode: 'api' } }
  }, {
    commandExists: () => true,
    run: () => { throw new Error('must not run'); }
  });

  assert.deepEqual(statuses, {
    codex: { commandAvailable: true, authState: 'api-configured', authMode: 'api' }
  });
});

test('provider status reports grok as authenticated from the terminal login file without returning secrets', async () => {
  const statuses = await providerStatusForSettings({
    providers: { grok: { command: 'grok', authMode: 'subscription' } }
  }, {
    commandExists: () => true,
    run: () => { throw new Error('must not run'); },
    fileExists: () => true,
    readFile: () => JSON.stringify({ 'https://auth.x.ai::example': { auth_mode: 'oauth', refresh_token: 'secret' } })
  });
  assert.deepEqual(statuses, {
    grok: { commandAvailable: true, authState: 'authenticated', authMode: 'subscription' }
  });
  assert.equal(JSON.stringify(statuses).includes('secret'), false);
});

test('provider status reports grok as unauthenticated when the terminal login file is missing', async () => {
  const statuses = await providerStatusForSettings({
    providers: { grok: { command: 'grok', authMode: 'subscription' } }
  }, {
    commandExists: () => true,
    run: () => { throw new Error('must not run'); },
    fileExists: () => false,
    readFile: () => { throw new Error('must not read'); }
  });
  assert.deepEqual(statuses, {
    grok: { commandAvailable: true, authState: 'unauthenticated', authMode: 'subscription' }
  });
});

test('provider status reports opencode as authenticated when its credential file has entries', async () => {
  const statuses = await providerStatusForSettings({
    providers: { opencode: { command: 'opencode', authMode: 'subscription' } }
  }, {
    commandExists: () => true,
    run: () => { throw new Error('must not run for a provider with no status command mapping'); },
    fileExists: () => true,
    readFile: () => JSON.stringify({ openai: { type: 'oauth' } })
  });

  assert.deepEqual(statuses, {
    opencode: { commandAvailable: true, authState: 'authenticated', authMode: 'subscription' }
  });
});

test('provider status reports opencode as unauthenticated when no credential file exists', async () => {
  const statuses = await providerStatusForSettings({
    providers: { opencode: { command: 'opencode', authMode: 'subscription' } }
  }, {
    commandExists: () => true,
    run: () => { throw new Error('must not run'); },
    fileExists: () => false,
    readFile: () => { throw new Error('must not read a file that does not exist'); }
  });

  assert.deepEqual(statuses, {
    opencode: { commandAvailable: true, authState: 'unauthenticated', authMode: 'subscription' }
  });
});

test('provider status reports opencode as unauthenticated when the credential file is empty JSON', async () => {
  const statuses = await providerStatusForSettings({
    providers: { opencode: { command: 'opencode', authMode: 'subscription' } }
  }, {
    commandExists: () => true,
    run: () => { throw new Error('must not run'); },
    fileExists: () => true,
    readFile: () => '{}'
  });

  assert.deepEqual(statuses, {
    opencode: { commandAvailable: true, authState: 'unauthenticated', authMode: 'subscription' }
  });
});

test('provider status marks opencode as unknown when its credential file is not valid JSON, without reading secrets into the result', async () => {
  const statuses = await providerStatusForSettings({
    providers: { opencode: { command: 'opencode', authMode: 'subscription' } }
  }, {
    commandExists: () => true,
    run: () => { throw new Error('must not run'); },
    fileExists: () => true,
    readFile: () => 'not-json{{{'
  });

  assert.deepEqual(statuses, {
    opencode: { commandAvailable: true, authState: 'unknown', authMode: 'subscription' }
  });
});

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runStatus } from '../provider-status.js';

const PROBE_OPTIONS = { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024, windowsHide: true };

async function withFakeCli(code, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rai-status-'));
  const file = path.join(dir, 'fake-cli');
  writeFileSync(file, `#!/usr/bin/env node\nprocess.exit(${code});\n`);
  chmodSync(file, 0o755);
  const savedPath = process.env.PATH;
  // A GUI-launched app has no ~/.local/bin and no Homebrew node on PATH.
  process.env.PATH = '/usr/bin:/bin';
  try { return await fn(file); }
  finally { process.env.PATH = savedPath; rmSync(dir, { recursive: true, force: true }); }
}

test('status probe runs the resolved binary and finds node on a GUI-minimal PATH', async () => {
  await withFakeCli(0, async file => {
    assert.deepEqual(await runStatus('claude', ['auth', 'status'], PROBE_OPTIONS, { resolve: () => file }), { status: 0 });
  });
});

test('status probe reports a real non-zero exit as that exit code', async () => {
  await withFakeCli(1, async file => {
    assert.deepEqual(await runStatus('claude', ['auth', 'status'], PROBE_OPTIONS, { resolve: () => file }), { status: 1 });
  });
});

test('status probe reports a missing binary as unknown, not signed out', async () => {
  const result = await runStatus('claude', ['auth', 'status'], PROBE_OPTIONS, { resolve: () => '/nonexistent/rai-cli' });
  assert.deepEqual(result, { status: null });
});

test('provider status maps probe failures that are not a sign-in answer to unknown', async () => {
  for (const status of [null, 126, 127]) {
    const statuses = await providerStatusForSettings({ providers: { claude: { command: 'claude' } } }, {
      commandExists: () => true,
      run: () => ({ status })
    });
    assert.equal(statuses.claude.authState, 'unknown', `status ${status}`);
  }
});

test('status probe never hands the bridge tokens to the provider CLI', async () => {
  const names = ['RAI_BRIDGE_TOKEN', 'RAI_OWNER_TOKEN', 'RAI_RUN_INSPECTOR_URL', 'RAI_BRIDGE_TOKEN_FILE'];
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rai-status-env-'));
  const file = path.join(dir, 'fake-cli');
  writeFileSync(file, `#!/usr/bin/env node\nprocess.exit(${JSON.stringify(names)}.some(name => process.env[name]) ? 9 : 0);\n`);
  chmodSync(file, 0o755);
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = 'secret';
  try {
    assert.deepEqual(await runStatus('claude', ['auth', 'status'], PROBE_OPTIONS, { resolve: () => file }), { status: 0 });
  } finally {
    for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    rmSync(dir, { recursive: true, force: true });
  }
});
