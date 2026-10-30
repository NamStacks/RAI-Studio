import { randomBytes, timingSafeEqual } from 'node:crypto';

export function createWsSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function tokensEqual(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function validateWebSocketUpgrade(req, { token, origin }) {
  let url;
  try { url = new URL(req.url || '/', 'http://bridge.invalid'); }
  catch { return { ok: false, status: 400, error: 'bad request target' }; }
  if (!tokensEqual(url.searchParams.get('token'), token)) {
    return { ok: false, status: 401, error: 'missing or invalid WebSocket session token' };
  }

  const requestOrigin = req.headers?.origin;
  if (requestOrigin) {
    return requestOrigin === origin
      ? { ok: true }
      : { ok: false, status: 403, error: 'forbidden WebSocket origin' };
  }

  // The embedded native app may omit Origin. Since this bridge binds only to
  // loopback, admit that app context only when the peer is loopback too.
  return isLoopback(req.socket?.remoteAddress)
    ? { ok: true }
    : { ok: false, status: 403, error: 'originless WebSocket connection must be loopback' };
}
