import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveProviderStatusDisplay } from '../public/provider-status-display.js';

// public-beta-readiness Phase 2, P0 finding #2: the Sign-in button used to
// just go disabled with no explanation when a provider CLI wasn't installed
// -- exactly the moment a first-time public user needs guidance most.

test('shows install guidance and a working link when the provider command is missing', () => {
  const display = resolveProviderStatusDisplay(
    { commandAvailable: false, authState: 'unavailable', authMode: 'subscription' },
    'claude',
  );
  assert.equal(display.disabled, true);
  assert.match(display.text, /claude.*isn't installed/);
  assert.ok(display.link);
  assert.equal(display.link.text, 'Install instructions');
  assert.match(display.link.url, /^https:\/\//);
});

test('falls back to the generic unavailable label for an unknown provider key', () => {
  const display = resolveProviderStatusDisplay(
    { commandAvailable: false, authState: 'unavailable' },
    'some-future-provider',
    {},
  );
  assert.equal(display.disabled, true);
  assert.equal(display.link, null);
  assert.match(display.text, /not available on PATH/);
});

test('enables sign-in and shows the normal label once the command is available', () => {
  const display = resolveProviderStatusDisplay(
    { commandAvailable: true, authState: 'unauthenticated', authMode: 'subscription' },
    'codex',
  );
  assert.equal(display.disabled, false);
  assert.equal(display.link, null);
  assert.equal(display.text, 'Sign in through the provider CLI');
});

test('stays disabled for explicit API-key auth mode even when the command is available', () => {
  const display = resolveProviderStatusDisplay(
    { commandAvailable: true, authState: 'api-configured', authMode: 'api' },
    'codex',
  );
  assert.equal(display.disabled, true);
});

test('handles a null status (e.g. failed fetch) without throwing, defaulting to disabled/unknown', () => {
  const display = resolveProviderStatusDisplay(null, 'claude');
  assert.equal(display.disabled, true);
  assert.equal(display.authState, 'unknown');
});
