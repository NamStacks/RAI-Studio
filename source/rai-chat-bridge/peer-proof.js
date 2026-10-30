import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const PEER_BODY_MAX_BYTES = 64 * 1024;
export function peerMac(token, label, nn, nb, port, body = '', method = 'POST', uri = '/api/workspace') {
  return createHmac('sha256', token).update([
    'rai-peer-v1', label, nn, nb, method, uri, String(port),
    createHash('sha256').update(body).digest('hex')
  ].join('\n')).digest('hex');
}
export function peerMatches(actual, expected) {
  return typeof actual === 'string' && /^[0-9a-f]{64}$/.test(actual) &&
    actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
