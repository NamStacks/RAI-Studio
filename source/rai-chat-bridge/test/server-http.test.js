import { proofNativeServer } from './helpers/callback-proof-fixture.js';
// Live-server integration tests for the CSRF/static-traversal fixes applied
// to /api/settings and serveStatic (security review 2026-07-27). server.js
// is a real entrypoint (not a pure module), so these spin up the actual
// process against an isolated RAI_BRIDGE_DIR/config and hit it over HTTP.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createServer } from 'node:http';
import { DEFAULT_CONFIG } from '../config.js';

// Transport fixture only, not proof of the owning compiled native authority.
let nativeFixture;
let nativeAvailable = true;
let nativeRevision = 'http-fixture-r1';
let nativeSettings = structuredClone(DEFAULT_CONFIG);
for (const profile of Object.values(nativeSettings.providers)) profile.command = '/usr/bin/false';
let nativeWrites = 0;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = path.join(__dirname, '..');

let child;
let port;
let baseUrl;
let sessionToken;

function nextInspectorSnapshot() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/pty?token=${encodeURIComponent(sessionToken)}`, {
      origin: baseUrl
    });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('run inspector snapshot was not replayed'));
    }, 3000);
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      let message;
      try { message = JSON.parse(data.toString('utf8')); } catch { return; }
      if (message.type !== 'run_inspector') return;
      clearTimeout(timer);
      socket.close();
      resolve(message.snapshot);
    });
    socket.on('error', reject);
  });
}

async function waitForListening(proc, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('bridge did not start: ' + buf)), timeoutMs);
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); resolve(parseInt(m[1], 10)); }
    });
    proc.stderr.on('data', (d) => { buf += d.toString(); });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error('bridge exited early with code ' + code + ': ' + buf)); });
  });
}

before(async () => {
  nativeFixture = createServer(proofNativeServer('integration-test-token', async (req, res, raw) => {
    if (!nativeAvailable) return res.writeHead(503).end('{}');
    assert.equal(req.url, '/settings');
    const fields = new URLSearchParams(raw);
    let status = 'ok';
    if (fields.get('operation') === 'save') {
      if (fields.get('expected_revision') !== nativeRevision) status = 'conflict';
      else {
        nativeSettings = JSON.parse(fields.get('settings'));
        nativeRevision = `http-fixture-r${++nativeWrites + 1}`;
        status = 'committed';
      }
    } else assert.equal(fields.get('operation'), 'read');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status, settings: nativeSettings, settings_revision: nativeRevision }));
  }));
  await new Promise(resolve => nativeFixture.listen(0, '127.0.0.1', resolve));
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-bridge-http-test-'));
  const cwdDir = mkdtempSync(path.join(os.tmpdir(), 'rai-bridge-http-cwd-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd: BRIDGE_DIR,
    env: {
      ...process.env,
      HOME: configDir,
      RAI_BRIDGE_PORT: '18973',
      RAI_BRIDGE_DIR: configDir,
      RAI_BRIDGE_CWD: cwdDir,
      RAI_BRIDGE_TOKEN: 'integration-test-token',
      RAI_SESSION_HEALTH_URL: `http://127.0.0.1:${nativeFixture.address().port}/health`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  port = await waitForListening(child);
  baseUrl = `http://127.0.0.1:${port}`;

  const indexHtml = await (await fetch(`${baseUrl}/`)).text();
  const m = indexHtml.match(/__RAI_WS_SESSION_TOKEN__\s*=\s*"([^"]+)"/);
  assert.ok(m, 'index.html must embed the WS session token');
  sessionToken = m[1];
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    // Bridge deliberately ignores SIGTERM to survive Restart R.
    // This exact disposable child is owned by the HTTP fixture.
    child.kill('SIGKILL');
    await exited;
  }
  await new Promise(resolve => nativeFixture.close(resolve));
});

test('/api/settings POST without the session token is rejected (CSRF fix)', async () => {
  const res = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'codex' })
  });
  assert.equal(res.status, 401);
});

test('/api/settings POST with a wrong session token is rejected', async () => {
  const res = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-RAI-Session-Token': 'not-the-real-token' },
    body: JSON.stringify({ provider: 'codex' })
  });
  assert.equal(res.status, 401);
});

test('/api/settings POST with the real session token succeeds', async () => {
  const snapshot = await (await fetch(`${baseUrl}/api/settings`, {
    headers: { 'X-RAI-Session-Token': sessionToken }
  })).json();
  const beforeWrites = nativeWrites;
  const res = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-RAI-Session-Token': sessionToken },
    body: JSON.stringify({ provider: 'claude', expected_revision: snapshot.settings_revision })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.provider, 'claude');
  assert.equal(nativeWrites, beforeWrites + 1);
  assert.equal(body.settings_revision, nativeRevision);
  const replay = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-RAI-Session-Token': sessionToken },
    body: JSON.stringify({ provider: 'codex', expected_revision: snapshot.settings_revision })
  });
  assert.equal(replay.status, 409);
  assert.equal(nativeWrites, beforeWrites + 1);
});

test('unavailable native settings refuses without a standalone fallback write', async () => {
  nativeAvailable = false;
  const beforeWrites = nativeWrites;
  try {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-RAI-Session-Token': sessionToken },
      body: JSON.stringify({ provider: 'codex', expected_revision: nativeRevision })
    });
    assert.equal(res.status, 503);
    assert.equal(nativeWrites, beforeWrites);
  } finally { nativeAvailable = true; }
});

test('native Settings Save commits while a provider status command is still pending', async () => {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'rai-status-pending-'));
  const started = path.join(fixtureDir, 'started');
  const completed = path.join(fixtureDir, 'completed');
  const command = path.join(fixtureDir, 'status.mjs');
  writeFileSync(command, `#!${process.execPath}\n` +
    `import { writeFileSync } from 'node:fs';\n` +
    `writeFileSync(${JSON.stringify(started)}, 'started');\n` +
    `setTimeout(() => { writeFileSync(${JSON.stringify(completed)}, 'done'); process.exit(0); }, 1000);\n`);
  chmodSync(command, 0o700);
  const previous = nativeSettings.providers.claude.command;
  nativeSettings.providers.claude.command = command;
  let statusRequest;
  try {
    const snapshot = await (await fetch(`${baseUrl}/api/settings`, {
      headers: { 'X-RAI-Session-Token': sessionToken }
    })).json();
    statusRequest = fetch(`${baseUrl}/api/provider-status`, {
      headers: { 'X-RAI-Session-Token': sessionToken }
    });
    const deadline = Date.now() + 5000;
    while (!existsSync(started) && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(started), 'real status subprocess started');
    const writesBefore = nativeWrites;
    const saved = await fetch(`${baseUrl}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RAI-Session-Token': sessionToken },
      body: JSON.stringify({ globalPrompt: 'save during account probe', expected_revision: snapshot.settings_revision })
    });
    assert.equal(saved.status, 200);
    assert.equal(nativeWrites, writesBefore + 1, 'one native CAS commit');
    assert.equal(existsSync(completed), false, 'status probe must not block the native Save lifecycle');
    const statuses = await (await statusRequest).json();
    assert.equal(statuses.providers.claude.authState, 'authenticated');
  } finally {
    if (statusRequest) await statusRequest;
    nativeSettings.providers.claude.command = previous;
  }
});

test('/api/provider-status without the session token is rejected', async () => {
  const res = await fetch(`${baseUrl}/api/provider-status`);
  assert.equal(res.status, 401);
});

test('serveStatic rejects a sibling-prefix path traversal (public-secret style)', async () => {
  // fetch()/browsers collapse '..' client-side before sending the request,
  // so exercise the raw HTTP layer directly to actually reach serveStatic's
  // path-confinement check with an unnormalized path.
  const net = await import('node:net');
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write('GET /../public-secret/x HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    });
    let data = '';
    socket.on('data', (d) => { data += d.toString(); });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  const statusLine = response.split('\r\n')[0];
  assert.match(statusLine, /^HTTP\/1\.1 403\b/);
});

test('serveStatic still serves legitimate files under public/', async () => {
  const res = await fetch(`${baseUrl}/terminal.js`);
  assert.equal(res.status, 200);
});

test('authenticated metadata-only run snapshot is visible over WebSocket and replayed on reconnect', async () => {
  const response = await fetch(`${baseUrl}/internal/run-inspector`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-RAI-Bridge-Token': 'integration-test-token'
    },
    body: JSON.stringify({
      state: 'running',
      elapsed_ms: 1250,
      quiet_ms: 250,
      output_bytes: 9000,
      output_growth_bytes: 12,
      deadline_ms: 7198750
    })
  });
  assert.equal(response.status, 204);

  const expected = {
    state: 'running',
    elapsed_ms: 1250,
    quiet_ms: 250,
    output_bytes: 9000,
    output_growth_bytes: 12,
    deadline_ms: 7198750
  };
  assert.deepEqual(await nextInspectorSnapshot(), expected);
  assert.deepEqual(await nextInspectorSnapshot(), expected);
  assert.equal(JSON.stringify(expected).includes('integration-test-token'), false);
});

test('raw Console fields are rejected without mutating or replaying browser inspector state', async () => {
  const before = await nextInspectorSnapshot();
  const secret = 'RAI_BRIDGE_TOKEN=review-secret-value';
  const response = await fetch(`${baseUrl}/internal/run-inspector`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-RAI-Bridge-Token': 'integration-test-token'
    },
    body: JSON.stringify({
      ...before,
      stdout_tail: secret,
      stderr_tail: 'arbitrary provider/session output',
      stdout: secret,
      stderr: 'arbitrary Console output'
    })
  });

  assert.equal(response.status, 400);
  const replayed = await nextInspectorSnapshot();
  assert.deepEqual(replayed, before);
  assert.equal(JSON.stringify(replayed).includes(secret), false);
  assert.equal(Object.keys(replayed).some((key) => /stdout|stderr/.test(key)), false);
});

test('oversized authenticated inspector POST returns 413 without broadcast or retained-state mutation', async () => {
  const expected = {
    state: 'running', elapsed_ms: 4321, quiet_ms: 123, output_bytes: 321,
    output_growth_bytes: 7, deadline_ms: 7195000
  };
  const seeded = await fetch(`${baseUrl}/internal/run-inspector`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-RAI-Bridge-Token': 'integration-test-token'
    },
    body: JSON.stringify(expected)
  });
  assert.equal(seeded.status, 204);

  const secret = 'RAI_BRIDGE_TOKEN=review-secret-value';
  const response = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/pty?token=${encodeURIComponent(sessionToken)}`, {
      origin: baseUrl
    });
    let sawReplay = false;
    let quietTimer;
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('oversized inspector request did not complete'));
    }, 3000);
    socket.on('message', async (data, isBinary) => {
      if (isBinary) return;
      let message;
      try { message = JSON.parse(data.toString('utf8')); } catch { return; }
      if (message.type !== 'run_inspector') return;
      if (sawReplay) {
        clearTimeout(timer);
        clearTimeout(quietTimer);
        socket.close();
        reject(new Error('oversized inspector request broadcast a snapshot'));
        return;
      }
      sawReplay = true;
      assert.deepEqual(message.snapshot, expected);
      try {
        const oversized = await fetch(`${baseUrl}/internal/run-inspector`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-RAI-Bridge-Token': 'integration-test-token'
          },
          body: JSON.stringify({ ...expected, padding: secret.repeat(1024) })
        });
        quietTimer = setTimeout(() => {
          clearTimeout(timer);
          socket.close();
          resolve(oversized);
        }, 100);
      } catch (error) {
        clearTimeout(timer);
        socket.close();
        reject(error);
      }
    });
    socket.on('error', reject);
  });

  assert.equal(response.status, 413);
  const responseBody = await response.text();
  assert.equal(responseBody, '');
  assert.equal(responseBody.includes(secret), false);
  assert.deepEqual(await nextInspectorSnapshot(), expected);
});

test('provider restart clears inspector state and reconnect replays idle', async () => {
  const updated = await fetch(`${baseUrl}/internal/run-inspector`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-RAI-Bridge-Token': 'integration-test-token'
    },
    body: JSON.stringify({
      state: 'running', elapsed_ms: 1, quiet_ms: 1, output_bytes: 1,
      output_growth_bytes: 1, deadline_ms: 100
    })
  });
  assert.equal(updated.status, 204);

  await new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/pty?token=${encodeURIComponent(sessionToken)}`, {
      origin: baseUrl
    });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('restart did not clear inspector state'));
    }, 3000);
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      let message;
      try { message = JSON.parse(data.toString('utf8')); } catch { return; }
      if (message.type !== 'run_inspector') return;
      if (message.snapshot.state === 'running') {
        socket.send(JSON.stringify({ type: 'restart' }));
      } else if (message.snapshot.state === 'idle') {
        clearTimeout(timer);
        socket.close();
        resolve();
      }
    });
    socket.on('error', reject);
  });

  assert.deepEqual(await nextInspectorSnapshot(), { state: 'idle' });
});

test('run inspector rejects missing bridge token and extra fields', async () => {
  const snapshot = {
    state: 'running', elapsed_ms: 1, quiet_ms: 1, output_bytes: 1,
    output_growth_bytes: 1, deadline_ms: 100
  };
  const [missingToken, extraField] = await Promise.all([
    fetch(`${baseUrl}/internal/run-inspector`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot)
    }),
    fetch(`${baseUrl}/internal/run-inspector`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-RAI-Bridge-Token': 'integration-test-token'
      },
      body: JSON.stringify({ ...snapshot, token: 'must-not-reach-browser' })
    })
  ]);

  assert.deepEqual([missingToken.status, extraField.status], [401, 400]);
});
