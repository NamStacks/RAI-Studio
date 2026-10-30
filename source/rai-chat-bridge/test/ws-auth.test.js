import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWsSessionToken, validateWebSocketUpgrade } from '../ws-auth.js';

function request({ token, origin, remoteAddress = '127.0.0.1' } = {}) {
  return {
    url: `/pty${token === undefined ? '' : `?token=${encodeURIComponent(token)}`}`,
    headers: origin === undefined ? {} : { origin },
    socket: { remoteAddress }
  };
}

test('WebSocket session tokens are unguessable and URL-safe', () => {
  const first = createWsSessionToken();
  const second = createWsSessionToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
});

test('WebSocket upgrade rejects missing and wrong session tokens', () => {
  const options = { token: 'valid-token', origin: 'http://127.0.0.1:8790' };
  assert.deepEqual(validateWebSocketUpgrade(request({ origin: options.origin }), options), { ok: false, status: 401, error: 'missing or invalid WebSocket session token' });
  assert.deepEqual(validateWebSocketUpgrade(request({ token: 'wrong-token', origin: options.origin }), options), { ok: false, status: 401, error: 'missing or invalid WebSocket session token' });
});

test('WebSocket upgrade rejects foreign origins but permits originless loopback app connections', () => {
  const options = { token: 'valid-token', origin: 'http://127.0.0.1:8790' };
  assert.deepEqual(validateWebSocketUpgrade(request({ token: options.token, origin: 'https://evil.example' }), options), { ok: false, status: 403, error: 'forbidden WebSocket origin' });
  assert.deepEqual(validateWebSocketUpgrade(request({ token: options.token }), options), { ok: true });
  assert.deepEqual(validateWebSocketUpgrade(request({ token: options.token, remoteAddress: '192.0.2.1' }), options), { ok: false, status: 403, error: 'originless WebSocket connection must be loopback' });
});
