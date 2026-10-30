import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { validateWebSocketUpgrade } from '../ws-auth.js';
import { createCaffeinateGuard } from '../caffeinate-guard.js';
import { commandExists } from '../mcp.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('WebSocket upgrade answers 400 to hostile request targets instead of throwing', () => {
  const options = { token: 'valid-token', origin: 'http://127.0.0.1:8790' };
  for (const url of ['//', '///', '//[', '/\\', '//?x']) {
    const result = validateWebSocketUpgrade({ url, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, options);
    assert.deepEqual(result, { ok: false, status: 400, error: 'bad request target' }, url);
  }
  const ok = validateWebSocketUpgrade({ url: '/pty?token=valid-token', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, options);
  assert.deepEqual(ok, { ok: true });
});

function sliceFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}\n', start) + 3);
}

test('nativeSettingsMessage passes only the native settings rejection text', () => {
  const nativeSettingsMessage = vm.runInNewContext(sliceFunction('nativeSettingsMessage') + '\nnativeSettingsMessage;');
  const fallback = 'Native settings unavailable.';
  const reject = message => nativeSettingsMessage(new Error(message), fallback);
  assert.equal(reject('native R session rejected settings (400): provider is not allowed'), 'provider is not allowed');
  assert.equal(reject('native R session rejected settings (400): ' + 'x'.repeat(500)), 'x'.repeat(300));
  assert.equal(reject('native R session rejected settings (400): line one\nline two'), fallback);
  assert.equal(reject('connect ECONNREFUSED 127.0.0.1:1'), fallback);
  assert.equal(nativeSettingsMessage(undefined, fallback), fallback);
  assert.equal(nativeSettingsMessage({}, fallback), fallback);
});

test('errorLabel reports only the error name and code', () => {
  const errorLabel = vm.runInNewContext(sliceFunction('errorLabel') + '\nerrorLabel;');
  assert.equal(errorLabel(Object.assign(new TypeError('secret token abc'), { code: 'ERR_X' })), 'TypeError ERR_X');
  assert.equal(errorLabel(new Error('secret token abc')), 'Error');
  assert.equal(errorLabel('plain string'), 'unknown');
  assert.equal(errorLabel(undefined), 'unknown');
  assert.equal(errorLabel({ name: 'bad\nname token=abc' }), 'badnametokenabc');
});

test('already-signed-in Grok sign-in resets the pane before the terminal starts', () => {
  const sent = [];
  const noop = () => {};
  const context = { config: { provider: 'grok', providers: { grok: { command: 'grok', authMode: 'subscription' } } },
    validateProfile: () => ({ ok: true }), commandExists: () => true, grokAuthState: () => 'authenticated',
    store: { term: null }, runInspector: { reset: noop }, pendingInput: null, stopTerm: noop,
    sendToClient: message => sent.push(message.type), start: () => { sent.push('start'); return true; } };
  vm.createContext(context);
  vm.runInContext(sliceFunction('startSignIn') + '\nstartSignIn();', context);
  assert.deepEqual(sent, ['already_signed_in', 'restarted', 'start']);
});

test('text-mode readBody decodes a multibyte character split across chunks once', async () => {
  const start = source.indexOf('function readBody('), end = source.indexOf('function sendJson', start);
  assert.ok(start >= 0 && end > start);
  const readBody = vm.runInNewContext(source.slice(start, end) + '\nreadBody;', { Buffer, setTimeout, clearTimeout });
  const text = '{"globalPrompt":"caf\u00e9 \u6f22\u5b57 \u{1F600}"}';
  const bytes = Buffer.from(text);
  for (let split = 1; split < bytes.length; split++) {
    const req = new EventEmitter();
    const result = readBody(req, 64 * 1024);
    req.emit('data', bytes.subarray(0, split));
    req.emit('data', bytes.subarray(split));
    req.emit('end');
    assert.equal(await result, text, `split at byte ${split}`);
  }
  const limited = new EventEmitter();
  const rejected = readBody(limited, 4);
  limited.emit('data', Buffer.from('\u00e9\u00e9\u00e9'));
  await assert.rejects(rejected, { code: 'REQUEST_BODY_TOO_LARGE' });
});

test('a WebSocket frame that parses to null or a scalar is ignored', () => {
  let connect;
  const store = { term: null, client: null, attach(ws) { this.client = ws; return null; }, detach() {}, snapshotOutput: () => null };
  const context = { Buffer, store, canonicalSettingsReady: true, terminalSize: { cols: 120, rows: 40 },
    sendToClient() {}, sendStatus() {}, runInspector: { get: () => ({}), reset() {} }, clearPendingInput() {},
    requestSession() {}, wss: { on: (event, fn) => { connect = fn; } }, server: { listen() {} }, PORT: 0, HOST: '127.0.0.1' };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf("wss.on('connection'")), context);
  const handlers = {};
  const ws = { OPEN: 1, readyState: 1, send() {}, close() {}, on: (event, fn) => { handlers[event] = fn; } };
  connect(ws);
  for (const frame of ['null', '1', '"x"', 'true', '[]', '{}']) {
    assert.doesNotThrow(() => handlers.message(Buffer.from(frame)), frame);
  }
});

function signInExitFixture({ client }) {
  const sent = [];
  let exit;
  const calls = { scheduleReap: 0, reset: 0, start: 0 };
  const store = { term: null, client, cancelReap() {}, scheduleReap() { calls.scheduleReap++; } };
  const context = { store, sent, calls, clearTimeout() {}, setTimeout: () => 0, INPUT_READY_DEADLINE_MS: 1000, Map, console,
    config: { provider: 'claude' }, terminalSize: { cols: 80, rows: 24 }, activeModels: new Map(),
    ActiveModelTracker: class { noteInput() {} observe() {} }, removeTermConfig() {}, clearPendingInput() {},
    runInspector: { reset() { calls.reset++; } }, sendToClient: message => sent.push(message.type),
    start() { calls.start++; return true; } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function wireTerm('), source.indexOf('\nfunction start()')), context);
  const term = { pid: 1, __signingIn: true, resize() {}, onData() {}, onExit(fn) { exit = fn; } };
  store.term = term;
  context.wireTerm(term);
  return { calls, sent, exit: () => exit({ exitCode: 0, signal: 0 }) };
}

test('sign-in exit resets the pane, resets the run inspector and arms the reap when no client is attached', () => {
  const detached = signInExitFixture({ client: null });
  detached.exit();
  assert.deepEqual(detached.sent, ['signin_complete', 'restarted']);
  assert.equal(detached.calls.start, 1);
  assert.equal(detached.calls.scheduleReap, 1);
  assert.equal(detached.calls.reset, 1);
  const attached = signInExitFixture({ client: {} });
  attached.exit();
  assert.equal(attached.calls.scheduleReap, 0);
});

test('createCaffeinateGuard listens for spawn errors', { skip: process.platform !== 'darwin' || !commandExists('caffeinate') }, () => {
  const child = new EventEmitter();
  const guard = createCaffeinateGuard({ pid: process.pid, spawn: () => child });
  assert.equal(guard, child);
  assert.ok(child.listenerCount('error') > 0);
  assert.doesNotThrow(() => child.emit('error', Object.assign(new Error('spawn caffeinate EAGAIN'), { code: 'EAGAIN' })));
});

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startBridge(t, extraEnv = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'rai-bridge-hardening-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, RAI_BRIDGE_PORT: String(port), RAI_BRIDGE_CWD: home, RAI_BRIDGE_TOKEN: 'hardening-test-token', ...extraEnv } });
  t.after(() => { child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`bridge did not start ${output}`)), 8000);
    child.stdout.on('data', chunk => { output += chunk; if (output.includes(`listening on http://127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`bridge exited ${code} ${output}`)); });
  });
  return { port, child };
}

function rawRequest(port, head) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(port, '127.0.0.1');
    const chunks = [];
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
    socket.on('error', reject);
    socket.write(head);
    setTimeout(() => socket.destroy(), 1500);
  });
}

test('hostile upgrade targets and non-ASCII token headers never end the bridge process', async t => {
  const { port, child } = await startBridge(t);
  let exited = false;
  child.once('exit', () => { exited = true; });
  const host = `Host: 127.0.0.1:${port}\r\n`;
  for (const target of ['//', '//[', '/\\']) {
    const reply = await rawRequest(port, `GET ${target} HTTP/1.1\r\n${host}Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    assert.match(reply, /^HTTP\/1\.1 400 /, target);
  }
  const high = Buffer.alloc(43, 0xe9).toString('latin1');
  const settings = await rawRequest(port, Buffer.from(`GET /api/provider-status HTTP/1.1\r\n${host}X-RAI-Session-Token: ${high}\r\nConnection: close\r\n\r\n`, 'latin1'));
  assert.match(settings, /^HTTP\/1\.1 401 /);
  const inspectorToken = Buffer.alloc('hardening-test-token'.length, 0xe9).toString('latin1');
  const inspector = await rawRequest(port, Buffer.from(`POST /internal/run-inspector HTTP/1.1\r\n${host}X-RAI-Bridge-Token: ${inspectorToken}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`, 'latin1'));
  assert.match(inspector, /^HTTP\/1\.1 401 /);
  const page = await rawRequest(port, `GET / HTTP/1.1\r\n${host}Connection: close\r\n\r\n`);
  assert.match(page, /^HTTP\/1\.1 200 /);
  assert.equal(exited, false);
});

function parentOriginReader(port) {
  const host = `Host: 127.0.0.1:${port}\r\n`;
  return async referer => {
    const reply = await rawRequest(port, `GET / HTTP/1.1\r\n${host}${referer === undefined ? '' : `Referer: ${referer}\r\n`}Connection: close\r\n\r\n`);
    return reply.match(/__RAI_PARENT_ORIGIN__ = "([^"]*)"/)[1];
  };
}

test('the pane parent origin stays empty when the spawn-time origin is empty or invalid', async t => {
  for (const spawnOrigin of ['', 'https://evil.example', 'not an origin']) {
    const { port } = await startBridge(t, { RAI_UI_PARENT_ORIGIN: spawnOrigin });
    const origin = parentOriginReader(port);
    assert.equal(await origin('http://127.0.0.1:2222/main.html'), '', spawnOrigin);
    assert.equal(await origin('http://localhost:3333/'), '', spawnOrigin);
    assert.equal(await origin(undefined), '', spawnOrigin);
  }
});

test('the pane parent origin follows the Referer of a loopback page when the spawn-time origin is valid', async t => {
  const { port } = await startBridge(t, { RAI_UI_PARENT_ORIGIN: 'http://127.0.0.1:1111' });
  const origin = parentOriginReader(port);
  assert.equal(await origin('http://127.0.0.1:2222/main.html?x=1'), 'http://127.0.0.1:2222');
  assert.equal(await origin('http://localhost:3333/'), 'http://localhost:3333');
  assert.equal(await origin('https://evil.example/'), 'http://127.0.0.1:1111');
  assert.equal(await origin('http://127.0.0.1.evil.example:2222/'), 'http://127.0.0.1:1111');
  assert.equal(await origin('not a url'), 'http://127.0.0.1:1111');
  assert.equal(await origin(undefined), 'http://127.0.0.1:1111');
});
