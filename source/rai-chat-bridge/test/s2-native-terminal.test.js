import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { buildCliLaunch } = await import(process.env.S2_MCP_MODULE || '../mcp.js');
for (const provider of ['claude', 'opencode']) {
  test(`${provider}: RAI approval settings never deny native Bash/Edit`, () => {
    for (const autoApprove of [true, false]) {
      const configDir = mkdtempSync(path.join(os.tmpdir(), 's2-native-'));
      try {
        const launch = buildCliLaunch({ provider, autoApprove, configDir,
          profile: { command: process.execPath, args: [] },
          env: { RAI_BRIDGE_TOKEN: 'fixture-token',
            RAI_SESSION_HEALTH_URL: 'http://127.0.0.1:19090/health' } });
        assert.equal(launch.args.includes('--disallowedTools'), false);
        assert.equal(launch.args.includes('--permission-mode'), false);
        const config = JSON.parse(readFileSync(launch.configPath, 'utf8'));
        if (provider === 'opencode') {
          assert.equal(config.permission, undefined);
          const inline = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT || '{}');
          assert.equal(inline.permission, undefined);
        }
      } finally { rmSync(configDir, { recursive: true, force: true }); }
    }
  });
}
