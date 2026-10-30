import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCliLaunch, BridgeConfigError } from '../mcp.js';
import { validateProjectFilePath } from '../rai-native-mcp.js';

// Invalid argv types still fail before session files are published
test('configured argv requires an array of strings', () => {
  for (const [provider, args] of [['codex', 'not-an-array'], ['claude', [42]]]) {
    const configDir = mkdtempSync(path.join(os.tmpdir(), 'pr12-inert-argv-'));
    try {
      assert.throws(() => buildCliLaunch({ provider, profile: { command: process.execPath, args },
        configDir, env: { RAI_BRIDGE_TOKEN: 'synthetic-only' } }), BridgeConfigError);
      assert.deepEqual(readdirSync(configDir), []);
    } finally { rmSync(configDir, { recursive: true, force: true }); }
  }
});

test('project read prevalidation allows environment sources but refuses internal auth/state', () => {
  for (const name of ['.raistudio/config', 'nested/.RAISTUDIO/state', 'nested\\.raistudio\\mcp.json'])
    assert.throws(() => validateProjectFilePath(name), /protected environment/i, name);
  for (const name of ['.env', 'nested/.env.local', '.ENVRC', 'nested\\.Renviron', '.Rprofile',
    'renv.lock', 'session.RData', 'sub/.Rapp.history',
    'analysis.R', 'nested/report.Rmd', 'data/derived.csv', 'env-notes.txt'])
    assert.equal(validateProjectFilePath(name), name);
});
