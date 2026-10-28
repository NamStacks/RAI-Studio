import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pty from 'node-pty';
import { buildCliLaunch, commandExists, createCliSession, removeSessionMcpConfig, resolveBinary } from '../mcp.js';
import { grokAuthState } from '../provider-status.js';

// Launches the installed grok through the bridge's own launch code. Skipped
// when grok is missing or signed out. The model prompt at the end spends a
// little account usage, so it runs only with RAI_REAL_GROK_PROMPT=1.
// Same lookup the app uses, so a Finder-launched PATH without ~/.local/bin is covered.
const grok = commandExists('grok') ? resolveBinary('grok') : '';
const ready = grok && grokAuthState() === 'authenticated';
// Grok records --trust in ~/.grok/trusted_folders.toml; drop only the entries these tests added.
// Grok keeps history per working folder under ~/.grok/sessions; drop the folders these tests created.
function forgetHistory(root) {
  const dir = path.join(os.homedir(), '.grok', 'sessions');
  const prefix = encodeURIComponent(realpathSync(root));
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) if (name.startsWith(prefix)) rmSync(path.join(dir, name), { recursive: true, force: true });
}
function untrust(root) {
  const file = path.join(os.homedir(), '.grok', 'trusted_folders.toml');
  if (!existsSync(file)) return;
  const prefix = `[folders.${JSON.stringify(path.join(realpathSync(root), 'grok-sessions') + '/').slice(0, -1)}`;
  const kept = readFileSync(file, 'utf8').split(/\n(?=\[)/).filter(block => !block.startsWith(prefix));
  writeFileSync(file, kept.join('\n').replace(/\n*$/, '\n'));
}
const env = { PATH: process.env.PATH, HOME: os.homedir(), TERM: 'xterm-256color', RAI_BRIDGE_TOKEN: 'grok-real-secret', RAI_OWNER_TOKEN: 'grok-real-secret', RAI_SESSION_HEALTH_URL: 'http://127.0.0.1:19090/health' };

test('real grok starts through the bridge launch without trust prompt or session error', { skip: !ready && 'grok missing or not signed in', timeout: 60000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'grok-real-'));
  const project = mkdtempSync(path.join(os.tmpdir(), 'grok-real-project-'));
  const bridgeDir = path.join(dir, 'bridge');
  const marker = path.join(dir, 'mcp-launched');
  let session;
  try {
    // A stub MCP entry point proves grok launched the session server.
    execFileSync('/bin/mkdir', ['-p', bridgeDir]);
    writeFileSync(path.join(bridgeDir, 'rai-native-mcp.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.env.RAI_BRIDGE_TOKEN ? 'ok' : 'no-token');\nprocess.stdin.resume();\n`);
    writeFileSync(path.join(project, 'marker.txt'), 'rai-project-marker');
    session = createCliSession({ provider: 'grok', profile: { command: grok, args: [] }, configDir: dir, bridgeDir, cwd: project, env, spawn: pty.spawn });
    let screen = '';
    session.term.onData(chunk => {
      screen += Buffer.from(chunk).toString('utf8');
      if (screen.includes('\x1b[6n')) session.term.write('\x1b[1;1R');
    });
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline && !(existsSync(marker) && screen.includes('Grok'))) await new Promise(r => setTimeout(r, 250));
    await new Promise(r => setTimeout(r, 1500));
    const text = screen.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ' ');
    assert.ok(!/trust the contents/i.test(text), 'no folder trust prompt');
    assert.ok(!/Session creation failed/i.test(text), 'no session creation error');
    assert.ok(existsSync(marker), 'grok launched the session MCP server');
    assert.equal(readFileSync(marker, 'utf8'), 'ok', 'session server received the bearer through its wrapper');
    assert.ok(!screen.includes(env.RAI_BRIDGE_TOKEN), 'bearer never reaches the grok terminal');
  } finally {
    try { session?.term.kill(); } catch {}
    if (session?.configPath) removeSessionMcpConfig(session.configPath, { configDir: dir });
    forgetHistory(dir);
    untrust(dir);
    rmSync(dir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('real grok reads and writes the project through the session link', { skip: (!ready && 'grok missing or not signed in') || (process.env.RAI_REAL_GROK_PROMPT !== '1' && 'set RAI_REAL_GROK_PROMPT=1'), timeout: 180000 }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'grok-real-'));
  const project = mkdtempSync(path.join(os.tmpdir(), 'grok-real-project-'));
  try {
    writeFileSync(path.join(project, 'marker.txt'), 'rai-project-marker');
    const launch = buildCliLaunch({ provider: 'grok', profile: { command: grok, args: [] }, configDir: dir, cwd: project, env });
    const sessionDir = launch.args[launch.args.indexOf('--cwd') + 1];
    const prompt = 'Read project/marker.txt, then create project/written-by-grok.txt containing exactly the same text. Reply done.';
    const result = spawnSync(grok, ['--trust', '--cwd', sessionDir, '-p', prompt, '--always-approve', '--max-turns', '6'], { env, encoding: 'utf8', timeout: 150000 });
    assert.equal(result.status, 0, 'headless grok exits cleanly');
    assert.equal(readFileSync(path.join(project, 'written-by-grok.txt'), 'utf8').trim(), 'rai-project-marker');
  } finally {
    forgetHistory(dir);
    untrust(dir);
    rmSync(dir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
