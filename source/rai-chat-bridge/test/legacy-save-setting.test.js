import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../config.js';
import { proofNativeServer } from './helpers/callback-proof-fixture.js';

// The real server.js in embedded (native) mode with a retired stored saveOnEdit.
// RAI saving is always on: any stored value is ignored and never rewritten.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startBridge(t, { failFirstRead = false, legacy = false } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'rai-legacy-save-'));
  mkdirSync(path.join(home, '.raistudio'), { recursive: true });
  // Native reads are raw stored JSON, without the UI-only theme and fontSize.
  let stored = { ...structuredClone(DEFAULT_CONFIG), provider: 'claude', caffeinate: false, saveOnEdit: legacy, autoApproveReadOnly: false };
  delete stored.theme;
  delete stored.fontSize;
  let revision = 1;
  const calls = { read: 0, save: 0 };
  const native = createHttpServer(proofNativeServer('settings-queue-token', async (req, res, raw) => {
    const values = new URLSearchParams(raw);
    res.setHeader('content-type', 'application/json');
    if (values.get('operation') === 'read') {
      calls.read += 1;
      if (failFirstRead && calls.read === 1) { res.statusCode = 503; return res.end('{"error":"not ready"}'); }
      return res.end(JSON.stringify({ status: 'ok', settings: stored, settings_revision: `r${revision}` }));
    }
    calls.save += 1;
    stored = JSON.parse(values.get('settings'));
    revision += 1;
    return res.end(JSON.stringify({ status: 'committed', settings: stored, settings_revision: `r${revision}` }));
  }));
  await new Promise((resolve, reject) => { native.once('error', reject); native.listen(0, '127.0.0.1', resolve); });
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { PATH: '/usr/bin:/bin', HOME: home, RAI_BRIDGE_DIR: home, RAI_BRIDGE_PORT: String(port), RAI_BRIDGE_CWD: home,
      RAI_BRIDGE_TOKEN: 'settings-queue-token', RAI_SESSION_HEALTH_URL: `http://127.0.0.1:${native.address().port}/health` },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = { log: '' };
  child.stdout.on('data', d => { output.log += d; });
  child.stderr.on('data', d => { output.log += d; });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    native.closeAllConnections();
    await new Promise(resolve => native.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !output.log.includes(`listening on http://127.0.0.1:${port}`) && child.exitCode === null; i++) await delay(100);
  assert.ok(output.log.includes(`listening on http://127.0.0.1:${port}`), `bridge starts: ${output.log}`);
  const url = `http://127.0.0.1:${port}`;
  const token = (await (await fetch(url)).text()).match(/__RAI_WS_SESSION_TOKEN__\s*=\s*"([^"]+)"/)?.[1];
  assert.ok(token);
  const getSettings = () => fetch(`${url}/api/settings`, { headers: { 'X-RAI-Session-Token': token }, signal: AbortSignal.timeout(5000) });
  return { getSettings, calls, output, stored: () => stored };
}

for (const legacy of [false, 'false', 0, null, 'garbage']) {
  test(`a stored saveOnEdit of ${JSON.stringify(legacy)} is ignored and never rewritten`, async t => {
    const bridge = await startBridge(t, { legacy });
    const first = await bridge.getSettings();
    assert.equal(first.status, 200, bridge.output.log);
    assert.equal((await first.json()).saveOnEdit, true);
    assert.equal(bridge.calls.save, 0, 'nothing is saved back to the native file');
    assert.deepEqual(bridge.stored().saveOnEdit, legacy, 'the stored value is untouched');
    assert.equal(bridge.stored().autoApproveReadOnly, false, 'the retired approval value is not rewritten');
    const second = await bridge.getSettings();
    assert.equal(second.status, 200, 'a second GET also answers');
    assert.equal((await second.json()).saveOnEdit, true);
    assert.equal(bridge.calls.save, 0);
  });
}

test('a failed first native read still lets a later GET answer without a save', async t => {
  const bridge = await startBridge(t, { failFirstRead: true });
  const first = await bridge.getSettings();
  assert.equal(first.status, 200, 'the first GET answers');
  assert.equal((await first.json()).saveOnEdit, true);
  assert.equal(bridge.calls.save, 0);
  assert.equal((await bridge.getSettings()).status, 200);
});
