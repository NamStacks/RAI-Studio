import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { INFLIGHT_MAX_MS, createProviderStatusCache } from '../provider-status.js';

const config = (claude = 'claude', authMode = 'subscription') =>
  ({ providers: { claude: { command: claude, authMode, args: [] }, codex: { command: 'codex', authMode: 'subscription' } } });
function countingLoader() {
  const state = { calls: 0, release: [] };
  state.load = () => { state.calls += 1; return new Promise(resolve => { state.release.push(() => resolve({ call: state.calls })); }); };
  return state;
}

test('concurrent requests await one probe', async () => {
  const stub = countingLoader();
  const cached = createProviderStatusCache(stub.load);
  const pending = [cached(config()), cached(config()), cached(config())];
  assert.equal(stub.calls, 1);
  stub.release[0]();
  const results = await Promise.all(pending);
  assert.deepEqual(results, [{ call: 1 }, { call: 1 }, { call: 1 }]);
});

test('a finished result is reused for 2 seconds, then probed again', async () => {
  let clock = 1000;
  const stub = countingLoader();
  const cached = createProviderStatusCache(stub.load, { now: () => clock });
  const first = cached(config()); stub.release[0](); await first;
  clock += 1999;
  assert.deepEqual(await cached(config()), { call: 1 });
  assert.equal(stub.calls, 1);
  clock += 2;
  const second = cached(config());
  assert.equal(stub.calls, 2);
  stub.release[1]();
  assert.deepEqual(await second, { call: 2 });
});

test('a change of provider command or auth mode never serves stale data', async () => {
  const stub = countingLoader();
  const cached = createProviderStatusCache(stub.load);
  const first = cached(config()); stub.release[0](); await first;
  const changedCommand = cached(config('/opt/other/claude')); stub.release[1](); await changedCommand;
  const changedMode = cached(config('/opt/other/claude', 'api')); stub.release[2](); await changedMode;
  assert.equal(stub.calls, 3);
  const back = cached(config('/opt/other/claude', 'api'));
  assert.equal(stub.calls, 3, 'the unchanged map still hits the cache');
  assert.deepEqual(await back, { call: 3 });
});

test('a failed probe is not cached and does not wedge later requests', async () => {
  let calls = 0;
  const cached = createProviderStatusCache(() => { calls += 1; return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve({ ok: calls }); });
  await assert.rejects(cached(config()), /boom/);
  assert.deepEqual(await cached(config()), { ok: 2 });
  assert.equal(calls, 2);
});

test('a never-settling probe is replaced after INFLIGHT_MAX_MS and cannot overwrite the new entry', async () => {
  let clock = 1000;
  const stub = countingLoader();
  const cached = createProviderStatusCache(stub.load, { now: () => clock });
  const hung = cached(config());
  clock += INFLIGHT_MAX_MS - 1;
  assert.equal(cached(config()), hung, 'a young in-flight probe is still shared');
  assert.equal(stub.calls, 1);
  clock += 1;
  const fresh = cached(config());
  assert.equal(stub.calls, 2, 'an in-flight entry at INFLIGHT_MAX_MS is dead');
  assert.notEqual(fresh, hung);
  stub.release[0]();
  assert.deepEqual(await hung, { call: 2 });
  assert.equal(cached(config()), fresh, 'the late old probe left the fresh entry in place');
  assert.equal(stub.calls, 2);
  stub.release[1]();
  assert.deepEqual(await fresh, { call: 2 });
  assert.deepEqual(await cached(config()), { call: 2 });
  assert.equal(stub.calls, 2, 'the fresh result is cached');
});

test('a late rejection from an abandoned probe leaves the fresh entry in place', async () => {
  let clock = 1000;
  const rejectors = [];
  let calls = 0;
  const cached = createProviderStatusCache(() => { calls += 1; return new Promise((resolve, reject) => { rejectors.push({ resolve, reject, call: calls }); }); }, { now: () => clock });
  const hung = cached(config());
  const hungSettled = assert.rejects(hung, /late/);
  clock += INFLIGHT_MAX_MS;
  const fresh = cached(config());
  rejectors[0].reject(new Error('late'));
  await hungSettled;
  assert.equal(cached(config()), fresh);
  assert.equal(calls, 2);
});

test('a result with an unknown provider is not reused, a definite one is', async () => {
  const results = [
    { claude: { authState: 'unknown' }, codex: { authState: 'authenticated' } },
    { claude: { authState: 'authenticated' }, codex: { authState: 'unauthenticated' } }
  ];
  let calls = 0;
  const gates = [];
  const cached = createProviderStatusCache(() => new Promise(resolve => { const result = results[calls]; calls += 1; gates.push(() => resolve(result)); }));
  const first = cached(config());
  const sharedWhileInFlight = cached(config());
  assert.equal(calls, 1, 'concurrent callers still share the probe');
  gates[0]();
  assert.deepEqual(await Promise.all([first, sharedWhileInFlight]), [results[0], results[0]]);
  const second = cached(config());
  assert.equal(calls, 2, 'an unknown result is probed again');
  gates[1]();
  assert.deepEqual(await second, results[1]);
  assert.deepEqual(await cached(config()), results[1]);
  assert.equal(calls, 2, 'a definite result is reused');
});

test('the default clock ignores wall-clock jumps', async t => {
  let wall = 1000;
  t.mock.method(Date, 'now', () => wall);
  const stub = countingLoader();
  const cached = createProviderStatusCache(stub.load);
  const first = cached(config()); stub.release[0](); await first;
  wall = 1e15;
  cached(config());
  assert.equal(stub.calls, 1, 'a jump of Date.now does not expire the entry');
});

test('a rejecting status load answers 503 and the bridge stays up', async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const home = mkdtempSync(path.join(os.tmpdir(), 'rai-status-reject-'));
  // Preload hook: make providerStatusForSettings reject, as an unexpected probe fault would.
  const hook = path.join(home, 'reject-hook.mjs');
  writeFileSync(hook, `export async function load(url, context, next) {
  const result = await next(url, context);
  if (!url.endsWith('/provider-status.js')) return result;
  const source = String(result.source);
  if (!source.includes('const statuses = {};')) throw new Error('hook anchor missing');
  return { ...result, source: source.replace('const statuses = {};', "throw new Error('probe exploded token=SECRET-VALUE');") };
}
`);
  const register = path.join(home, 'register.mjs');
  writeFileSync(register, `import { register } from 'node:module';\nregister(${JSON.stringify(pathToFileURL(hook).href)});\n`);
  const probe = await new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  let output = '';
  const child = spawn(process.execPath, ['--import', pathToFileURL(register).href, 'server.js'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, RAI_BRIDGE_PORT: String(probe), RAI_BRIDGE_CWD: home, RAI_BRIDGE_TOKEN: 'status-reject-token' } });
  t.after(() => { child.kill('SIGKILL'); });
  child.stderr.on('data', chunk => { output += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bridge did not start ${output}`)), 8000);
    child.stdout.on('data', chunk => { output += chunk; if (output.includes(`listening on http://127.0.0.1:${probe}`)) { clearTimeout(timer); resolve(); } });
  });
  const url = `http://127.0.0.1:${probe}`;
  const token = (await (await fetch(url)).text()).match(/__RAI_WS_SESSION_TOKEN__\s*=\s*"([^"]+)"/)[1];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${url}/api/provider-status`, { headers: { 'X-RAI-Session-Token': token } });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'provider status unavailable' });
  }
  assert.equal(child.exitCode, null, 'the bridge process is still running');
  assert.equal((await fetch(url)).status, 200, 'the bridge still serves requests');
  assert.match(output, /provider status probe failed/);
  assert.doesNotMatch(output, /SECRET-VALUE/, 'no probe detail is logged');
});

test('GET /api/provider-status runs each provider CLI once for concurrent requests', async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const home = mkdtempSync(path.join(os.tmpdir(), 'rai-status-cache-'));
  const bin = path.join(home, 'bin');
  mkdirSync(bin);
  for (const name of ['claude', 'codex']) {
    writeFileSync(path.join(bin, name), `#!/bin/sh\necho x >> "${home}/${name}.count"\nsleep 0.4\nexit 0\n`);
    chmodSync(path.join(bin, name), 0o755);
  }
  const probe = await new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const child = spawn(process.execPath, ['server.js'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, RAI_BRIDGE_PORT: String(probe), RAI_BRIDGE_CWD: home, RAI_BRIDGE_TOKEN: 'status-cache-token' } });
  t.after(() => { child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`bridge did not start ${output}`)), 8000);
    child.stdout.on('data', chunk => { output += chunk; if (output.includes(`listening on http://127.0.0.1:${probe}`)) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', chunk => { output += chunk; });
  });
  const url = `http://127.0.0.1:${probe}`;
  const token = (await (await fetch(url)).text()).match(/__RAI_WS_SESSION_TOKEN__\s*=\s*"([^"]+)"/)[1];
  const ask = () => fetch(`${url}/api/provider-status`, { headers: { 'X-RAI-Session-Token': token } }).then(r => r.json());
  const answers = await Promise.all([ask(), ask(), ask()]);
  for (const answer of answers) {
    assert.equal(answer.providers.claude.authState, 'authenticated');
    assert.equal(answer.providers.codex.authState, 'authenticated');
  }
  assert.equal(await ask().then(() => readFileSync(`${home}/claude.count`, 'utf8').trim().split('\n').length), 1, 'claude probed once');
  assert.equal(readFileSync(`${home}/codex.count`, 'utf8').trim().split('\n').length, 1, 'codex probed once');
  assert.equal(existsSync(`${home}/claude.count`), true);
});
