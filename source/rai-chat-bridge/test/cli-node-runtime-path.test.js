import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, realpathSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCliLaunch, removeSessionMcpConfig } from '../mcp.js';

const bridgeDir = fileURLToPath(new URL('..', import.meta.url));
test('native CLI with env-node shebang uses the user PATH Node', { skip: process.platform === 'win32' }, () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-cli-node-path-'));
  const alternateNode = process.execPath.includes('node@22') ? '/opt/homebrew/Cellar/node/26.5.0/bin/node' : '/opt/homebrew/Cellar/node@22/22.22.2_2/bin/node';
  const userNode = existsSync(alternateNode) ? alternateNode : process.execPath;
  symlinkSync(userNode, path.join(configDir, 'node'));
  const userPath = `${configDir}:/usr/bin:/bin`;
  const command = path.join(configDir, 'claude');
  writeFileSync(command, '#!/usr/bin/env node\n' +
    `if (process.env.RAI_BRIDGE_TOKEN || process.env.RAI_OWNER_TOKEN || process.env.RAI_RUN_INSPECTOR_URL) process.exit(9);\n` +
    `process.stdout.write(JSON.stringify({execPath:process.execPath}));\n`);
  chmodSync(command, 0o700);
  const launch = buildCliLaunch({
    provider: 'claude', profile: { command, args: [] }, autoApprove: false,
    configDir, bridgeDir,
    env: { HOME: configDir, PATH: userPath, RAI_SESSION_HEALTH_URL: 'http://127.0.0.1:19090/rsession-local/rai-assistant/health', RAI_BRIDGE_TOKEN: 'test-adapter-only', RAI_OWNER_TOKEN: 'test-adapter-only', RAI_RUN_INSPECTOR_URL: 'http://127.0.0.1:1/internal/run-inspector' }
  });
  try {
    const result = spawnSync(launch.command, launch.args, { env: launch.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(realpathSync(JSON.parse(result.stdout).execPath), realpathSync(userNode));
    assert.equal(launch.env.PATH, userPath, 'preserve inherited PATH exactly');
  } finally { removeSessionMcpConfig(launch.configPath, {configDir}); }
});

test('absent inherited PATH remains absent', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-cli-empty-path-'));
  const launch = buildCliLaunch({
    provider: 'claude', profile: { command: process.execPath, args: [] },
    autoApprove: false, configDir, bridgeDir,
    env: { RAI_BRIDGE_TOKEN: 'test-adapter-only', RAI_SESSION_HEALTH_URL: 'http://127.0.0.1:19090/rsession-local/rai-assistant/health' }
  });
  try { assert.equal(Object.hasOwn(launch.env, 'PATH'), false); }
  finally { removeSessionMcpConfig(launch.configPath, {configDir}); }
});
