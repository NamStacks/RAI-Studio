import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { skillSourceStatus } from '../skill-status.js';
import { skillHint } from '../public/skill-hints.js';

test('skill visibility distinguishes found source from executed skill; unknown remains honest', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rai-skill-status-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  mkdirSync(home); mkdirSync(cwd);
  for (const [provider, folder] of [['claude', '.claude'], ['codex', '.agents'], ['opencode', '.opencode']]) {
    const dir = path.join(cwd, folder, 'skills', 'user-owned-test');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: user-owned-test\ndescription: Fixture\n---\n');
    const status = skillSourceStatus(provider, 'user-owned-test', { home, cwd });
    assert.equal(status.availability, 'source_found_invocation_unverified');
    assert.equal(status.source, 'project');
    assert.match(status.message, /verify provider loading/i);
    const missing = skillSourceStatus(provider, 'unavailable-test-skill', { home, cwd });
    assert.equal(missing.availability, 'not_found_in_known_paths');
    assert.match(missing.message, /No skill source found/);
    assert.match(missing.message, /different working directory/);
  }
  for (const name of ['../outside', 'bad/name', '__proto__', 'x'.repeat(66)])
    assert.throws(() => skillSourceStatus('claude', name, { home, cwd }), /Invalid skill name/);
  assert.throws(() => skillSourceStatus('anthropic', 'user-owned-test', { home, cwd }), /Unsupported/);
});

test('provider-native syntax hints never claim portability, installation or execution', () => {
  assert.deepEqual(skillHint('claude', '/user-owned-test').name, 'user-owned-test');
  assert.equal(skillHint('claude', '$user-owned-test').supported, false);
  assert.equal(skillHint('codex', '$user-owned-test').supported, true);
  assert.match(skillHint('codex', '$user-owned-test').message, /Press Tab to select.*Enter to send/);
  assert.equal(skillHint('codex', '/user-owned-test').supported, false);
  assert.equal(skillHint('opencode', '/user-owned-test').supported, false);
  assert.match(skillHint('opencode', 'Use the native skill tool').message, /native skill tool/);
});
