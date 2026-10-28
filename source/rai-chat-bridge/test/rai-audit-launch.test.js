import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCliLaunch } from '../mcp.js';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AUDIT_SKILL_DIR = path.join(REPO_ROOT, 'skills', 'rai-audit');
const AUDIT_SKILL = path.join(AUDIT_SKILL_DIR, 'SKILL.md');
const AUDIT_PLUGIN_MANIFEST = path.join(AUDIT_SKILL_DIR, '.claude-plugin', 'plugin.json');
const COMPANION_PROMPT = path.join(REPO_ROOT, 'prompts', 'RAI-Assistant.md');
const TEST_ENV = {
  PATH: process.env.PATH,
  RAI_BRIDGE_TOKEN: 'audit-test-token',
  RAI_SESSION_HEALTH_URL: 'http://127.0.0.1:19090/rsession-local/rai-assistant/health',
};
const CLAUDE_PROFILE = Object.freeze({ command: process.execPath, args: [] });

function skillText() {
  return readFileSync(AUDIT_SKILL, 'utf8');
}

test('Claude launch registers the portable rai-audit plugin for this session only', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-audit-config-'));
  const home = mkdtempSync(path.join(os.tmpdir(), 'rai-audit-home-'));
  const launch = buildCliLaunch({
    provider: 'claude',
    profile: CLAUDE_PROFILE,
    env: { ...TEST_ENV, HOME: home },
    configDir,
    bridgeDir: REPO_ROOT,
  });

  try {
    const flag = launch.args.indexOf('--plugin-dir');
    assert.notEqual(flag, -1);
    assert.equal(launch.args[flag + 1], path.join(`${launch.configPath}.session`, 'plugin'));
    const name = Object.keys(JSON.parse(readFileSync(launch.configPath)).mcpServers)[0];
    assert.ok(readFileSync(path.join(launch.args[flag + 1], 'SKILL.md'), 'utf8').includes(`mcp__${name}__*`));
    assert.equal(launch.args.includes('--settings'), false);
    assert.equal(launch.args.includes('--plugin-url'), false);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('Claude launch skips the bundled plugin when the user already has a rai-audit skill', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-audit-config-'));
  const home = mkdtempSync(path.join(os.tmpdir(), 'rai-audit-home-'));
  const claudeDir = mkdtempSync(path.join(os.tmpdir(), 'rai-audit-claude-'));
  try {
    for (const [env, root] of [[{ HOME: home }, path.join(home, '.claude')], [{ HOME: home, CLAUDE_CONFIG_DIR: claudeDir }, claudeDir]]) {
      mkdirSync(path.join(root, 'skills', 'rai-audit'), { recursive: true });
      writeFileSync(path.join(root, 'skills', 'rai-audit', 'SKILL.md'), '---\nname: rai-audit\n---\n');
      const launch = buildCliLaunch({ provider: 'claude', profile: CLAUDE_PROFILE, env: { ...TEST_ENV, ...env }, configDir, bridgeDir: REPO_ROOT });
      assert.equal(launch.args.includes('--plugin-dir'), false, `one /rai-audit only (${root})`);
      rmSync(path.join(root, 'skills'), { recursive: true, force: true });
    }
  } finally {
    for (const dir of [configDir, home, claudeDir]) rmSync(dir, { recursive: true, force: true });
  }
});

test('rai-audit skill is a validated Claude plugin that resolves as /rai-audit', () => {
  assert.equal(existsSync(AUDIT_SKILL), true);
  assert.equal(existsSync(AUDIT_PLUGIN_MANIFEST), true);
  assert.match(skillText(), /^---\nname: rai-audit\n/m);
  assert.deepEqual(JSON.parse(readFileSync(AUDIT_PLUGIN_MANIFEST, 'utf8')).skills, ['./']);

  const validation = spawnSync('claude', ['plugin', 'validate', AUDIT_SKILL_DIR, '--strict', '--json'], {
    encoding: 'utf8',
  });
  assert.equal(validation.status, 0, validation.stderr || validation.stdout);
  assert.equal(JSON.parse(validation.stdout).success, true);
});

test('companion prompt gives /rai-audit the same native approval and observation boundaries', () => {
  const text = readFileSync(COMPANION_PROMPT, 'utf8');
  assert.match(text, /\/rai-audit/);
  assert.match(text, /automatically approved when valid/i);
  assert.doesNotMatch(text, /Full Auto|otherwise exact Allow-once/i);
  assert.match(text, /direct edits of original data or environment\/profile files are refused/i);
  assert.match(text, /quiet heartbeat is not a stall/i);
  assert.match(text, /native plot image review is required/i);
  assert.doesNotMatch(text, /Rscript.*audit|audit.*Rscript/i);
});

test('portable audit guidance preserves scientific evidence and native safety boundaries', () => {
  const text = skillText();
  for (const phase of ['Reachability','Source','IDE','Metadata','Data','Provenance','Arithmetic','Figures','Tables','Claims','Review','Fixes','Report']) assert.match(text, new RegExp('\\d+\\. '+phase+':'));

  assert.match(text, /native plot image review is required/i);
  assert.match(text, /audit a batch once/i);
  assert.match(text, /raw inputs are read-only/i);
  assert.match(text, /never force a promise or active binding/i);
  assert.match(text, /quiet heartbeat is not a stall/i);
  assert.match(text, /automatically approved when valid/i);
  assert.doesNotMatch(text, /Full Auto|otherwise exact Allow-once/i);
  assert.match(text, /direct edits of original data are refused/i);
  assert.match(text, /get_audit_workflow/, 'documents the parent-owned future contract without invoking it');
  assert.doesNotMatch(text, /get0\(n\)|eval\(parse/i);
});


test('Codex embedded launch injects the native RAI contract as developer guidance, not blanket tool permission', () => {
  const configDir=mkdtempSync(path.join(os.tmpdir(),'rai-codex-guidance-'));
  try {
    const launch=buildCliLaunch({provider:'codex',profile:CLAUDE_PROFILE,env:TEST_ENV,configDir,bridgeDir:REPO_ROOT});
    const index=launch.args.indexOf('developer_instructions');
    const setting=launch.args.find(arg=>arg.startsWith('developer_instructions='));
    assert.equal(index,-1);
    assert.ok(setting);
    const text=JSON.parse(setting.slice('developer_instructions='.length));
    assert.match(text,/strict proposal to `run_r`/);
    assert.match(text,/Do not use `Rscript`/);
    assert.match(text,/get_run_result/);
    assert.ok(!launch.args.some(arg=>/dangerously-bypass|approval_policy=never/.test(arg)));
  } finally {rmSync(configDir,{recursive:true,force:true});}
});

test('OpenCode session-only config injects identical native RAI guidance without global writes', () => {
  const configDir=mkdtempSync(path.join(os.tmpdir(),'rai-opencode-guidance-'));
  try {
    const launch=buildCliLaunch({provider:'opencode',profile:CLAUDE_PROFILE,env:TEST_ENV,configDir,bridgeDir:REPO_ROOT});
    const config=JSON.parse(readFileSync(launch.configPath,'utf8'));
    assert.deepEqual(config.instructions,[`${launch.configPath}.instructions.md`]);
    const inline=JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
    assert.ok(readFileSync(config.instructions[0],'utf8').includes(`mcp__${Object.keys(inline.mcp)[0]}__*`));
    assert.deepEqual(Object.keys(config.mcp),['rai']);
  } finally {rmSync(configDir,{recursive:true,force:true});}
});

test('Codex session launch approves only native-gated rai tools, never blanket CLI bypass', () => {
  const configDir=mkdtempSync(path.join(os.tmpdir(),'rai-codex-policy-'));
  try {
    const launch=buildCliLaunch({provider:'codex',profile:CLAUDE_PROFILE,env:TEST_ENV,configDir,bridgeDir:REPO_ROOT});
    assert.ok(launch.args.map(v=>v.replace(/rai_studio_session_[a-f0-9]+/g,'rai')).includes('mcp_servers.rai.tools.get_audit_workflow.approval_mode="approve"'));
    assert.ok(launch.args.map(v=>v.replace(/rai_studio_session_[a-f0-9]+/g,'rai')).includes('mcp_servers.rai.tools.run_r.approval_mode="approve"'));
    assert.ok(launch.args.map(v=>v.replace(/rai_studio_session_[a-f0-9]+/g,'rai')).includes('mcp_servers.rai.tools.edit_document.approval_mode="approve"'));
    assert.ok(!launch.args.some(a=>/dangerously|approval_policy=|default_tools_approval/.test(a)));
    assert.equal(launch.env.RAI_BRIDGE_TOKEN,undefined);
  } finally {rmSync(configDir,{recursive:true,force:true});}
});
