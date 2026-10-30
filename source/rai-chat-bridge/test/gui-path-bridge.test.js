import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { DEFAULT_CONFIG } from '../config.js';
import { proofNativeServer } from './helpers/callback-proof-fixture.js';

// The real server.js, started the way a Finder or Dock launch starts it: a
// minimal PATH with no ~/.local/bin, no Homebrew and no nvm. The provider CLIs
// live only in ~/.local/bin, and Codex is a `#!/usr/bin/env node` script.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GUI_PATH = '/usr/bin:/bin';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

for (const provider of ['claude', 'codex']) {
  test(`${provider}: bridge started with a GUI PATH reports signed in and launches the CLI with a usable PATH`, async t => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'rai-gui-path-'));
    const record = path.join(home, 'child-path.txt');
    const bin = path.join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    mkdirSync(path.join(home, '.raistudio'), { recursive: true });
    writeFileSync(path.join(home, '.raistudio', 'assistant.json'), JSON.stringify({ provider, providers: {} }), { mode: 0o600 });
    const cli = path.join(bin, provider);
    const probe = provider === 'claude' ? ['auth', 'status'] : ['login', 'status'];
    writeFileSync(cli, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === ${JSON.stringify(probe[0])} && args[1] === ${JSON.stringify(probe[1])}) process.exit(0);
require('node:fs').writeFileSync(${JSON.stringify(record)}, process.env.PATH);
setTimeout(() => process.exit(0), 20000);
`, { mode: 0o700 });
    chmodSync(cli, 0o700);
    const native = createHttpServer(proofNativeServer('gui-path-token', async (req, res) => {
      const settings = structuredClone(DEFAULT_CONFIG);
      settings.provider = provider;
      settings.caffeinate = false;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', settings, settings_revision: 'gui-path-r1' }));
    }));
    await new Promise((resolve, reject) => { native.once('error', reject); native.listen(0, '127.0.0.1', resolve); });
    const port = await freePort();
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { PATH: GUI_PATH, HOME: home, RAI_BRIDGE_DIR: home, RAI_BRIDGE_PORT: String(port), RAI_BRIDGE_CWD: home, RAI_BRIDGE_TOKEN: 'gui-path-token',
        RAI_SESSION_HEALTH_URL: `http://127.0.0.1:${native.address().port}/health` },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });
    let ws;
    t.after(async () => {
      ws?.terminate();
      if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
      native.closeAllConnections();
      await new Promise(resolve => native.close(resolve));
      rmSync(home, { recursive: true, force: true });
    });
    for (let i = 0; i < 100 && !log.includes(`listening on http://127.0.0.1:${port}`) && child.exitCode === null; i++) await delay(100);
    assert.ok(log.includes(`listening on http://127.0.0.1:${port}`), `bridge starts: ${log}`);
    const url = `http://127.0.0.1:${port}`;
    const token = (await (await fetch(url)).text()).match(/__RAI_WS_SESSION_TOKEN__\s*=\s*"([^"]+)"/)?.[1];
    assert.ok(token);

    const status = await (await fetch(`${url}/api/provider-status`, { headers: { 'X-RAI-Session-Token': token } })).json();
    assert.equal(status.providers[provider].commandAvailable, true, 'CLI found in ~/.local/bin');
    assert.equal(status.providers[provider].authState, 'authenticated', 'a successful status command is signed in');

    ws = new WebSocket(`ws://127.0.0.1:${port}/pty?token=${token}`, { origin: url });
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    for (let i = 0; i < 100 && !existsSync(record); i++) await delay(100);
    assert.ok(existsSync(record), `the CLI started (a node script exits 127 without node on PATH): ${log}`);
    const childPath = readFileSync(record, 'utf8').split(path.delimiter);
    assert.deepEqual(childPath.slice(0, 2), ['/usr/bin', '/bin'], 'inherited PATH keeps its priority');
    assert.ok(childPath.includes(bin), 'the CLI directory was added');
    assert.ok(childPath.includes(path.dirname(process.execPath)), 'node is reachable');
  });
}
