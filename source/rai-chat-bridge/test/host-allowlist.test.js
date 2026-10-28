import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// DNS rebinding protection: only loopback Host names reach any route.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
function request(port, { method = 'GET', pathname = '/', host, headers = {}, body } = {}) {
  const sent = { ...headers };
  if (host !== undefined) sent.Host = host;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: sent, setHost: false }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function startBridge(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'rai-host-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, RAI_BRIDGE_PORT: String(port), RAI_BRIDGE_CWD: home, RAI_BRIDGE_TOKEN: 'host-test-token' } });
  t.after(() => { child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`bridge did not start ${output}`)), 8000);
    child.stdout.on('data', chunk => { output += chunk; if (output.includes(`listening on http://127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`bridge exited ${code} ${output}`)); });
  });
  return port;
}

test('loopback Host names are served, any other Host is refused before routing', async t => {
  const port = await startBridge(t);
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LocalHost:${port}`, `[::1]:${port}`, '127.0.0.1']) {
    const page = await request(port, { host });
    assert.equal(page.status, 200, `GET / with Host ${host}`);
    assert.match(page.text, /__RAI_WS_SESSION_TOKEN__/);
  }
  const token = (await request(port, { host: `127.0.0.1:${port}` })).text.match(/__RAI_WS_SESSION_TOKEN__\s*=\s*"([^"]+)"/)[1];
  for (const host of [`evil.example:${port}`, 'evil.example', `127.0.0.1.evil.example:${port}`, `localhost.evil.example:${port}`,
    `evil.example:${port}@127.0.0.1`, `[::2]:${port}`, '']) {
    const page = await request(port, { host });
    assert.equal(page.status, 403, `GET / with Host ${JSON.stringify(host)}`);
    assert.doesNotMatch(page.text, /__RAI_WS_SESSION_TOKEN__/, 'the session token never leaves');
    const settings = await request(port, { pathname: '/api/settings', host, headers: { 'X-RAI-Session-Token': token } });
    assert.equal(settings.status, 403, `GET /api/settings with Host ${JSON.stringify(host)}`);
    const inspector = await request(port, { method: 'POST', pathname: '/internal/run-inspector', host, headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(inspector.status, 403, `POST /internal/run-inspector with Host ${JSON.stringify(host)}`);
    const asset = await request(port, { pathname: '/terminal.js', host });
    assert.equal(asset.status, 403, 'static files are covered too');
  }
  const settings = await request(port, { pathname: '/api/settings', host: `localhost:${port}`, headers: { 'X-RAI-Session-Token': token } });
  assert.equal(settings.status, 200);
  const inspector = await request(port, { method: 'POST', pathname: '/internal/run-inspector', host: `127.0.0.1:${port}`, body: '{}' });
  assert.notEqual(inspector.status, 403, 'a loopback Host reaches the route, which applies its own authentication');
});

test('a missing Host header is refused', async t => {
  const port = await startBridge(t);
  const response = await new Promise((resolve, reject) => {
    const socket = createConnection(port);
    let text = '';
    socket.on('data', chunk => { text += chunk; });
    socket.on('end', () => resolve(text));
    socket.on('error', reject);
    socket.write('GET / HTTP/1.0\r\n\r\n');
  });
  assert.match(response, /^HTTP\/1\.[01] 403 /);
  assert.doesNotMatch(response, /__RAI_WS_SESSION_TOKEN__/);
});

test('a WebSocket upgrade with a valid token and origin is refused under a foreign Host', async t => {
  const port = await startBridge(t);
  const token = (await request(port, { host: `127.0.0.1:${port}` })).text.match(/__RAI_WS_SESSION_TOKEN__\s*=\s*"([^"]+)"/)[1];
  const upgrade = host => new Promise((resolve, reject) => {
    const socket = createConnection(port);
    let text = '';
    socket.on('data', chunk => {
      text += chunk;
      if (/\r\n\r\n/.test(text)) { socket.destroy(); resolve(text.split('\r\n')[0]); }
    });
    socket.on('close', () => resolve(text.split('\r\n')[0]));
    socket.on('error', reject);
    socket.write(`GET /?token=${token} HTTP/1.1\r\nHost: ${host}\r\nOrigin: http://127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
      + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
  });
  assert.match(await upgrade(`127.0.0.1:${port}`), /^HTTP\/1\.1 101 /, 'a loopback Host still upgrades');
  assert.match(await upgrade(`evil.example:${port}`), /^HTTP\/1\.1 403 /, 'a foreign Host never upgrades');
});
