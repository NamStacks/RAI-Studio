import { peerMac as makePeerMac, peerMatches as matchPeerProof, PEER_BODY_MAX_BYTES } from '../peer-proof.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import http from 'node:http';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const K = 'disposable-peer-proof-key';
const nn = 'a1'.repeat(32);
const body = JSON.stringify({ cwd: '/peer-project' });
function mac(label, a, b, port = 18790, bytes = '') {
  return createHmac('sha256', K).update(['rai-peer-v1', label, a, b, 'POST', '/api/workspace', port,
    createHash('sha256').update(bytes).digest('hex')].join('\n')).digest('hex');
}
function fixture(port = 18790) {
  let now = 100;
  const context = vm.createContext({ Buffer, Map, JSON, Object, Date: { now: () => now },
    createHash, createHmac, randomBytes, timingSafeEqual, path, makePeerMac, matchPeerProof, PEER_BODY_MAX_BYTES,
    statSync: () => ({ isDirectory: () => true }), requireBridgeToken: () => K,
    setTimeout, clearTimeout, server: { address: () => ({ port }) },
    sendJson: (res, status, value) => {
      res.status = status; res.value = value;
      res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
    } });
  const readerStart = source.indexOf('function readBody(');
  vm.runInContext(source.slice(readerStart, source.indexOf('function sendJson', readerStart)), context);
  const start = source.indexOf('const WORKSPACE_BODY_MAX_BYTES =');
  assert.ok(start >= 0, 'production peer challenge store is required');
  const end = source.indexOf('async function handleRunInspector', start);
  vm.runInContext('let CWD;\n' + source.slice(start, end) + '\nglobalThis.handlers = { handlePeerChallenge, handleWorkspace };', context);
  async function call(route, bytes, headers = {}) {
    const res = { writeHead(status) { this.status = status; return this; }, end(callback) { if (typeof callback === 'function') callback(); } };
    const req = bytes instanceof PassThrough ? bytes : new PassThrough();
    req.headers = headers;
    const pending = context.handlers[route](req, res);
    if (!(bytes instanceof PassThrough)) req.end(bytes);
    await pending;
    res.requestDestroyed = req.destroyed;
    return res;
  }
  return { handlers: context.handlers, call, advance(ms) { now += ms; },
    async challenge(a = nn) { return call('handlePeerChallenge', JSON.stringify({ v: 1, nn: a })); },
    workspace(nb, proof, bytes = body, headers = {}) {
      return call('handleWorkspace', bytes, { 'x-rai-peer-nonce': nb, 'x-rai-peer-proof': proof, ...headers });
    } };
}
test('peer route is dispatched only for POST', () => {
  assert.match(source, /url === '\/api\/peer-challenge' && req.method === 'POST'.*handlePeerChallenge/);
});
test('peer proof binds role, both nonces, port and empty-body digest; valid workspace acknowledges exact bytes', async () => {
  const f = fixture(), c = await f.challenge();
  assert.equal(c.status, 200); assert.match(c.value.nb, /^[0-9a-f]{64}$/);
  assert.equal(c.value.proof, mac('bridge-proof', nn, c.value.nb));
  const r = await f.workspace(c.value.nb, mac('native-proof', nn, c.value.nb, 18790, body));
  assert.equal(r.status, 200); assert.equal(r.value.ack, mac('bridge-ack', nn, c.value.nb, 18790, body));
});
test('workspace rejects legacy bearer, including bearer plus valid proof', async () => {
  const f = fixture();
  assert.equal((await f.call('handleWorkspace', body, { 'x-rai-bridge-token': K })).status, 401);
  const { value: c } = await f.challenge();
  assert.equal((await f.workspace(c.nb, mac('native-proof', nn, c.nb, 18790, body), body, { 'x-rai-bridge-token': K })).status, 401);
});
test('workspace nonce is consumed before verification and cannot be replayed', async () => {
  const f = fixture(), { value: c } = await f.challenge();
  const proof = mac('native-proof', nn, c.nb, 18790, body);
  assert.equal((await f.workspace(c.nb, proof)).status, 200);
  assert.equal((await f.workspace(c.nb, proof)).status, 401);
  const { value: d } = await f.challenge();
  assert.equal((await f.workspace(d.nb, 'bad')).status, 401);
  assert.equal((await f.workspace(d.nb, mac('native-proof', nn, d.nb, 18790, body))).status, 401);
});
test('workspace rejects expired nonce at the five second boundary with injected clock', async () => {
  const f = fixture(), { value: c } = await f.challenge(); f.advance(5000);
  assert.equal((await f.workspace(c.nb, mac('native-proof', nn, c.nb, 18790, body))).status, 401);
});
test('workspace rejects role reflection, other port, other nn, and altered body', async () => {
  for (const variant of ['role', 'port', 'nn', 'body']) {
    const f = fixture(), { value: c } = await f.challenge();
    const proof = mac(variant === 'role' ? 'bridge-proof' : 'native-proof', variant === 'nn' ? 'b2'.repeat(32) : nn,
      c.nb, variant === 'port' ? 18791 : 18790, variant === 'body' ? body + ' ' : body);
    assert.equal((await f.workspace(c.nb, proof)).status, 401, variant);
  }
});
test('challenge validates fixed-size hex nonce and protocol version', async () => {
  const f = fixture();
  for (const value of [{ v: 2, nn }, { v: 1, nn: 'short' }, { v: 1, nn: 'g'.repeat(64) }, { v: 1, nn, cwd: '/private' }])
    assert.equal((await f.call('handlePeerChallenge', JSON.stringify(value))).status, 400);
});
test('challenge store cap evicts oldest and expired entries', async () => {
  const f = fixture(), { value: first } = await f.challenge();
  for (let i = 0; i < 16; ++i) await f.challenge();
  assert.equal((await f.workspace(first.nb, mac('native-proof', nn, first.nb, 18790, body))).status, 401);
  f.advance(5001);
  assert.equal((await f.challenge()).status, 200);
});

test('workspace body reader hashes exact bytes across split UTF-8 chunks', async () => {
  const { EventEmitter } = await import('node:events');
  const start = source.indexOf('function readBody('), end = source.indexOf('function sendJson', start);
  const readBody = vm.runInNewContext(source.slice(start, end) + '\nreadBody;', { Buffer, setTimeout, clearTimeout });
  const req = new EventEmitter(), bytes = Buffer.from('{"cwd":"/caf\u00e9"}');
  const result = readBody(req, 64 * 1024, true);
  const split = bytes.indexOf(0xc3) + 1;
  req.emit('data', bytes.subarray(0, split)); req.emit('data', bytes.subarray(split)); req.emit('end');
  assert.deepEqual(await result, bytes);
});

test('workspace actual reader rejects oversized stream with 413, destroys it and consumes nonce', async () => {
  const f = fixture(), { value: c } = await f.challenge();
  const stream = new PassThrough();
  const pending = f.workspace(c.nb, 'bad', stream);
  stream.write(Buffer.alloc(64 * 1024));
  stream.write(Buffer.alloc(1));
  stream.end();
  const response = await pending;
  assert.equal(response.status, 413);
  assert.equal(response.requestDestroyed, true);
  assert.equal((await f.workspace(c.nb, 'bad')).status, 401);
});

test('workspace actual reader accepts split UTF-8 and acknowledges exact bytes', async () => {
  const f = fixture(), { value: c } = await f.challenge();
  const bytes = Buffer.from(JSON.stringify({ cwd: '/café' }));
  const stream = new PassThrough();
  const pending = f.workspace(c.nb, mac('native-proof', nn, c.nb, 18790, bytes), stream);
  const split = bytes.indexOf(0xc3) + 1;
  stream.write(bytes.subarray(0, split)); stream.end(bytes.subarray(split));
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.value.ack, mac('bridge-ack', nn, c.nb, 18790, bytes));
});

test('actual body reader expires a stream without EOF', async () => {
  const start = source.indexOf('function readBody(');
  const reader = vm.runInNewContext(source.slice(start, source.indexOf('function sendJson', start)) + '\nreadBody;',
    { Buffer, setTimeout, clearTimeout });
  const stream = new PassThrough();
  await assert.rejects(reader(stream, 64 * 1024, true, 20), { code: 'REQUEST_BODY_EXPIRED' });
  stream.destroy();
});

test('real listener returns 413 for oversized workspace and rejects nonce retry', { skip: process.env.RAI_PEER_LISTENER_TEST !== '1' }, async t => {
  let f;
  const server = http.createServer((req, res) => f.handlers[req.url === '/challenge' ? 'handlePeerChallenge' : 'handleWorkspace'](req, res));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  f = fixture(server.address().port);
  const base = `http://127.0.0.1:${server.address().port}`;
  const challenge = await fetch(base + '/challenge', { method: 'POST', body: JSON.stringify({ v: 1, nn }) });
  const { nb } = await challenge.json();
  const headers = { 'x-rai-peer-nonce': nb, 'x-rai-peer-proof': 'bad' };
  assert.equal((await fetch(base + '/workspace', { method: 'POST', headers, body: Buffer.alloc(65537) })).status, 413);
  assert.equal((await fetch(base + '/workspace', { method: 'POST', headers, body })).status, 401);
});

test('workspace read expires at remaining nonce lifetime, destroys stream and consumes nonce', async () => {
  const f = fixture(), { value: c } = await f.challenge();
  f.advance(4990);
  const stream = new PassThrough();
  const response = await f.workspace(c.nb, 'bad', stream);
  assert.equal(response.status, 401);
  assert.equal(response.requestDestroyed, true);
  assert.equal((await f.workspace(c.nb, 'bad')).status, 401);
});

test('workspace accepts exactly 64 KiB and native PATH_MAX x4 cwd payload', async () => {
  for (const bytes of [Buffer.from(body.padEnd(65536)), Buffer.from(JSON.stringify({ cwd: '/' + '😀'.repeat(4095) }))]) {
    const f = fixture(), { value: c } = await f.challenge();
    assert.ok(bytes.length <= 65536);
    assert.equal((await f.workspace(c.nb, mac('native-proof', nn, c.nb, 18790, bytes), bytes)).status, 200);
  }
});
