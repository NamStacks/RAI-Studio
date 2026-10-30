import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ActiveModelTracker,
  parseActiveModelBanner,
  resolveRequestedModel,
  resolveVerifiedModelAlias,
  settingsCatalogForActiveModels
} from '../model-reflection.js';

const root = new URL('../', import.meta.url);
const read = relative => readFileSync(fileURLToPath(new URL(relative, root)), 'utf8');

test('parses old and current Claude startup banners, including ANSI', () => {
  const output = '\u001b[2J╭─ Codex ─────────────────\n│ model: gpt-5.6-sol ultra\n╰──────────────────────────';
  assert.equal(parseActiveModelBanner('codex', output), 'gpt-5.6-sol');
  assert.equal(parseActiveModelBanner('claude', '\u001b[2J╭─ Claude Code ─\n│ Model: claude-sonnet-4-5\n'), 'claude-sonnet-4-5');
  assert.equal(parseActiveModelBanner('claude', '╭─ Claude Code ─\n│ Sonnet 5 with high effort · Claude Max'), 'Sonnet 5');
  assert.equal(parseActiveModelBanner('codex', 'assistant reply: model: invented-model'), null);
});

test('opencode has no documented stable startup banner format, so active-model parsing safely returns null rather than guessing', () => {
  assert.equal(parseActiveModelBanner('opencode', '╭─ opencode ─\n│ model: anthropic/claude-sonnet-4-5\n'), null);
  assert.equal(parseActiveModelBanner('opencode', ''), null);
});

test('tracks fragmented Claude startup banners', () => {
  const tracker = new ActiveModelTracker('claude');
  assert.equal(tracker.observe('\u001b[2J╭─ Claude Code ─\n│ Model: claude-son'), null);
  assert.equal(tracker.observe('net-4-5\n'), 'claude-sonnet-4-5');
});

test('does not trust post-input output unless the model command receives confirmation', () => {
  const tracker = new ActiveModelTracker('codex');
  tracker.noteInput('hello\r');
  assert.equal(tracker.observe('Codex\nmodel: fabricated'), null);
  tracker.noteInput('/model sol\r');
  assert.equal(tracker.observe('Model changed to gpt-5.6-sol'), 'gpt-5.6-sol');
});

test('resolves aliases only against names actually reported by an active terminal', () => {
  const reported = ['gpt-5.6-sol'];
  assert.deepEqual(resolveVerifiedModelAlias('sol', reported), { ok: true, model: 'gpt-5.6-sol' });
  assert.deepEqual(resolveVerifiedModelAlias('gpt-5.6-sol', reported), { ok: true, model: 'gpt-5.6-sol' });
  assert.deepEqual(resolveVerifiedModelAlias('', reported), { ok: true, model: '' });
  assert.deepEqual(resolveVerifiedModelAlias('terra', reported), { ok: true, model: '', fallback: true });
  assert.deepEqual(resolveVerifiedModelAlias('sol', []), { ok: true, model: '', fallback: true });
});

test('scopes subscription aliases to their providers', () => {
  assert.deepEqual(resolveRequestedModel({ provider: 'claude', authMode: 'subscription', value: 'opus' }), { ok: true, model: 'opus' });
  assert.deepEqual(resolveRequestedModel({ provider: 'claude', authMode: 'api', value: 'opus' }), { ok: true, model: '', fallback: true });
  assert.deepEqual(resolveRequestedModel({ provider: 'codex', authMode: 'subscription', value: 'opus', activeModel: 'gpt-5.6-sol' }), { ok: true, model: '', fallback: true });
  assert.deepEqual(resolveRequestedModel({ provider: 'codex', authMode: 'subscription', value: 'sol' }), { ok: true, model: 'gpt-5.6-sol' });
  assert.deepEqual(resolveRequestedModel({ provider: 'codex', authMode: 'subscription', value: 'terra' }), { ok: true, model: 'gpt-5.6-terra' });
  assert.deepEqual(resolveRequestedModel({ provider: 'codex', authMode: 'subscription', value: 'luna' }), { ok: true, model: 'gpt-5.6-luna' });
});

test('settings expose active and reported models without a CLI catalog or static guesses', () => {
  const config = {
    provider: 'codex', model: '',
    providers: {
      codex: { authMode: 'subscription', models: ['api-only-model'] },
      claude: { authMode: 'subscription', models: ['opus'] }
    }
  };
  const settings = settingsCatalogForActiveModels(config, { codex: ['gpt-5.6-sol'] });
  assert.equal(settings.providers.codex.activeModel, 'gpt-5.6-sol');
  assert.deepEqual(settings.providers.codex.reportedModels, ['gpt-5.6-sol']);
  assert.deepEqual(settings.providers.claude.reportedModels, []);
  assert.equal(settings.providers.codex.models, undefined);
});

test('settings UI keeps provider account model defaults', () => {
  const client = read('public/terminal.js');
  const server = read('server.js');
  const catalog = read('model-catalog.js');

  assert.match(client, /provider\.reportedModels/);
  assert.match(client, /provider\.activeModel = msg\.model/);
  assert.match(client, /msg\.type === 'active_model'/);
  assert.doesNotMatch(client, /modelInput\.value = msg\.model/);
  const body = client.slice(client.indexOf('function settingsBody()'), client.indexOf('async function persistSettings()'));
  assert.match(body, /return \{ provider: providerSel\.value, globalPrompt:/);
  assert.doesNotMatch(body, /model:|effort:/);
  assert.match(client, /data\?\.fallback/);
  assert.match(client, /endpoint\.searchParams\.set\('token', wsSessionToken\)/);
  assert.match(server, /type: 'active_model'/);
  assert.doesNotMatch(client, /debug models/);
  assert.doesNotMatch(catalog, /debug models/);
});
