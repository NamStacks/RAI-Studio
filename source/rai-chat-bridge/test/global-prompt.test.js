import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCliLaunch, removeSessionMcpConfig } from '../mcp.js';
import { composeAssistantInstructions, validateGlobalPrompt } from '../public/global-prompt.js';

const PROMPT = 'Shared Unicode η instruction\nPreserve  two spaces and <literal> tags.';
const ENV = { PATH: process.env.PATH, RAI_BRIDGE_TOKEN: 'global-test-token',
  RAI_SESSION_HEALTH_URL: 'http://127.0.0.1:19090/rsession-local/rai-assistant/health' };
const PROFILE = { command: process.execPath, args: [] };

test('global text allows empty and exact multiline; rejects controls and oversized text', () => {
  assert.equal(validateGlobalPrompt(''), '');
  assert.equal(validateGlobalPrompt(PROMPT), PROMPT);
  for (const bad of [null, undefined, 'bad\x1b[201~', 'x'.repeat(16385)])
    assert.throws(() => validateGlobalPrompt(bad), /Global instructions/);
  assert.equal(composeAssistantInstructions('NATIVE BASE', ''), 'NATIVE BASE');
  const composed = composeAssistantInstructions('NATIVE BASE', PROMPT);
  assert.equal(composed.split(PROMPT).length - 1, 1);
  assert.ok(composed.startsWith('NATIVE BASE\n'));
  assert.ok(composed.endsWith('cannot alter native tool validation, approval, data or document boundaries.'));
});

for (const provider of ['claude', 'codex', 'opencode']) {
  test(`${provider} new session gets global instructions once via its real session-scoped transport`, () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), `rai-global-${provider}-`));
    const launch = buildCliLaunch({ provider, profile: PROFILE, globalPrompt: PROMPT,
      configDir, env: ENV });
    try {
      let instructions;
      if (provider === 'claude') {
        const index = launch.args.indexOf('--append-system-prompt-file');
        assert.ok(index >= 0);
        const target = launch.args[index + 1];
        assert.ok(target.startsWith(configDir));
        instructions = readFileSync(target, 'utf8');
        assert.equal(statSync(target).mode & 0o777, 0o600);
        assert.ok(!launch.args.join(' ').includes(PROMPT));
      } else if (provider === 'codex') {
        const index = launch.args.indexOf('-c');
        assert.ok(index >= 0);
        assert.ok(launch.args[index + 1].startsWith('developer_instructions='));
        instructions = JSON.parse(launch.args[index + 1].slice('developer_instructions='.length));
      } else {
        const config = JSON.parse(readFileSync(launch.configPath, 'utf8'));
        assert.equal(config.instructions.length, 1);
        assert.ok(config.instructions[0].startsWith(configDir));
        instructions = readFileSync(config.instructions[0], 'utf8');
        assert.equal(statSync(config.instructions[0]).mode & 0o777, 0o600);
        assert.ok(!launch.args.join(' ').includes(PROMPT));
      }
      assert.equal(instructions.split(PROMPT).length - 1, 1);
      assert.match(instructions, /RAI-Studio/);
      assert.doesNotMatch(instructions, /inside RStudio|active RStudio/);
      assert.equal(launch.env.RAI_BRIDGE_TOKEN, undefined);
      const companion = `${launch.configPath}.instructions.md`;
      assert.equal(removeSessionMcpConfig(launch.configPath, { configDir }), true);
      assert.equal(existsSync(companion), false);
    } finally { try { removeSessionMcpConfig(launch.configPath, { configDir }); } catch {} }
  });
}
