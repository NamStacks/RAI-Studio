import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCliLaunch, removeSessionMcpConfig } from '../mcp.js';

const env = { PATH: process.env.PATH, HOME: os.homedir(), RAI_BRIDGE_TOKEN: 'grok-synthetic-secret', RAI_OWNER_TOKEN: 'grok-synthetic-secret', RAI_SESSION_HEALTH_URL: 'http://127.0.0.1:19090/health' };

function launch(dir, project) {
  return buildCliLaunch({ provider: 'grok', profile: { command: 'grok', args: [] }, configDir: dir, cwd: project, env });
}

test('grok sessions reuse one fixed folder per project and never pass --add-dir', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'grok-session-'));
  const project = mkdtempSync(path.join(os.tmpdir(), 'grok-project-'));
  try {
    const first = launch(dir, project);
    const second = launch(dir, project);
    for (const run of [first, second]) {
      assert.ok(!run.args.includes('--add-dir'));
      assert.ok(run.args.includes('--trust'));
    }
    const cwds = [first, second].map(run => run.args[run.args.indexOf('--cwd') + 1]);
    assert.equal(cwds[0], cwds[1], 'one fixed folder per project keeps Grok history for --continue');
    assert.equal(path.basename(cwds[0]), 'session');
    assert.equal(path.dirname(path.dirname(cwds[0])), path.join(dir, 'grok-sessions'));
    const other = mkdtempSync(path.join(os.tmpdir(), 'grok-project-'));
    try {
      const third = launch(dir, other);
      assert.notEqual(path.dirname(third.args[third.args.indexOf('--cwd') + 1]), path.dirname(cwds[0]), 'projects never share a trust scope');
    } finally { rmSync(other, { recursive: true, force: true }); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('removing a grok session deletes its folder and keeps the user project', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'grok-session-'));
  const project = mkdtempSync(path.join(os.tmpdir(), 'grok-project-'));
  try {
    writeFileSync(path.join(project, 'keep.txt'), 'user data');
    const run = launch(dir, project);
    const sessionDir = run.args[run.args.indexOf('--cwd') + 1];
    assert.ok(existsSync(path.join(sessionDir, 'project', 'keep.txt')));
    assert.equal(removeSessionMcpConfig(run.configPath, { configDir: dir }), true);
    assert.equal(existsSync(sessionDir), false);
    assert.equal(readFileSync(path.join(project, 'keep.txt'), 'utf8'), 'user data');
    assert.deepEqual(readdirSync(path.dirname(sessionDir)).filter(name => name !== '.git'), []);
    assert.deepEqual(readdirSync(dir).filter(name => name.startsWith('mcp-')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('grok launch flags land before the user terminator and the server name reaches the MCP entry', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'grok-session-'));
  const project = mkdtempSync(path.join(os.tmpdir(), 'grok-project-'));
  try {
    const run = buildCliLaunch({ provider: 'grok', profile: { command: 'grok', args: ['--model', 'X', '--', 'my prompt'] }, configDir: dir, cwd: project, env });
    const terminator = run.args.indexOf('--');
    assert.ok(run.args.indexOf('--trust') < terminator);
    assert.ok(run.args.indexOf('--cwd') < terminator);
    assert.deepEqual(run.args.slice(terminator), ['--', 'my prompt']);
    const sessionDir = run.args[run.args.indexOf('--cwd') + 1];
    const toml = readFileSync(path.join(sessionDir, '.grok', 'config.toml'), 'utf8');
    const name = toml.match(/\[mcp_servers\.(rai_studio_session_[a-f0-9]+)\]/)[1];
    assert.ok(toml.includes(`RAI_MCP_SERVER_NAME = "${name}"`));
    const notes = readFileSync(path.join(sessionDir, 'AGENTS.md'), 'utf8');
    assert.ok(notes.includes('./project/AGENTS.md'));
    assert.ok(notes.includes('This folder is an RAI-Studio assistant session.'));
    assert.ok(!notes.includes('RStudio assistant session'));
    assert.ok(!notes.includes(env.RAI_BRIDGE_TOKEN));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('server.js imports grokAuthState before using it, and checks it after stopping the old terminal', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /import \{[^}]*\bgrokAuthState\b[^}]*\} from '\.\/provider-status\.js'/);
  assert.ok(server.indexOf("stopTerm(oldTerm, { restarting: true });\n  pendingInput = pending;\n  if (alreadySignedIn)") > 0);
});

test('grok launch refuses reserved flags, rejects a symlinked root, and clears planted trusted config', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'grok-session-'));
  const project = mkdtempSync(path.join(os.tmpdir(), 'grok-project-'));
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'grok-elsewhere-'));
  try {
    for (const flag of [['--add-dir', '/x'], ['--cwd=/x'], ['--trust']]) {
      assert.throws(() => buildCliLaunch({ provider: 'grok', profile: { command: 'grok', args: flag }, configDir: dir, cwd: project, env }), /RAI connector conflict/);
    }
    assert.deepEqual(readdirSync(dir), [], 'refusal happens before any file is created');
    const run = launch(dir, project);
    const projectRoot = path.dirname(run.args[run.args.indexOf('--cwd') + 1]);
    mkdirSync(path.join(projectRoot, '.grok'));
    writeFileSync(path.join(projectRoot, '.grok', 'config.toml'), '[mcp_servers.evil]\ncommand = "/bin/sh"\n');
    writeFileSync(path.join(projectRoot, 'AGENTS.md'), 'planted');
    launch(dir, project);
    assert.equal(existsSync(path.join(projectRoot, '.grok')), false);
    assert.equal(existsSync(path.join(projectRoot, 'AGENTS.md')), false);
    rmSync(path.join(dir, 'grok-sessions'), { recursive: true, force: true });
    symlinkSync(elsewhere, path.join(dir, 'grok-sessions'));
    assert.throws(() => launch(dir, project), /real directory/);
    assert.deepEqual(readdirSync(elsewhere), [], 'nothing written through the link');
  } finally {
    for (const d of [dir, project, elsewhere]) rmSync(d, { recursive: true, force: true });
  }
});

test('a stale-scan failure never blocks a launch', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'grok-session-'));
  const project = mkdtempSync(path.join(os.tmpdir(), 'grok-project-'));
  try {
    writeFileSync(path.join(dir, 'grok-sessions'), 'not a directory');
    assert.throws(() => launch(dir, project), /real directory|ENOTDIR|EEXIST/);
    for (const provider of ['claude', 'codex', 'opencode']) {
      assert.doesNotThrow(() => buildCliLaunch({ provider, profile: { command: provider, args: [] }, configDir: dir, cwd: project, env }));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('removing an older launch keeps the fixed folder written by a newer one', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'grok-session-'));
  const project = mkdtempSync(path.join(os.tmpdir(), 'grok-project-'));
  try {
    const first = launch(dir, project);
    const second = launch(dir, project);
    const sessionDir = second.args[second.args.indexOf('--cwd') + 1];
    removeSessionMcpConfig(first.configPath, { configDir: dir });
    assert.ok(existsSync(path.join(sessionDir, '.grok', 'config.toml')), 'newer launch keeps its folder');
    removeSessionMcpConfig(second.configPath, { configDir: dir });
    assert.equal(existsSync(sessionDir), false);
    assert.equal(existsSync(path.join(path.dirname(sessionDir), 'session.owner')), false);
    const again = launch(dir, project);
    assert.equal(again.args[again.args.indexOf('--cwd') + 1], sessionDir, 'same path after a restart, so history resumes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('a live bridge process owning the fixed folder pushes this launch to a private folder', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'grok-session-'));
  const project = mkdtempSync(path.join(os.tmpdir(), 'grok-project-'));
  try {
    const first = launch(dir, project);
    const sessionDir = first.args[first.args.indexOf('--cwd') + 1];
    writeFileSync(path.join(path.dirname(sessionDir), 'session.owner'), String(process.ppid));
    const second = launch(dir, project);
    const privateDir = second.args[second.args.indexOf('--cwd') + 1];
    assert.notEqual(privateDir, sessionDir);
    assert.match(path.basename(privateDir), /^mcp-\d+-[0-9a-f-]+\.sh\.session$/);
    assert.ok(existsSync(path.join(sessionDir, '.grok', 'config.toml')), 'the other process keeps its folder');
    removeSessionMcpConfig(second.configPath, { configDir: dir });
    assert.equal(existsSync(privateDir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
