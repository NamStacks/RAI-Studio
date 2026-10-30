import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SNIPPETS } from '../public/scoped-guidance.js';
import { LEGACY_DEFAULT_SNIPPETS } from './fixtures/legacy-default-snippets.js';
import { createHash } from 'node:crypto';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function start(home, port) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, RAI_BRIDGE_PORT: String(port),
      RAI_BRIDGE_CWD: home, RAI_BRIDGE_TOKEN: 'snippets-test-token' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('bridge did not start '+output)), 8000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes(`listening on http://127.0.0.1:${port}`)) {
        clearTimeout(timer); resolve();
      }
    });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('bridge exited '+code+' '+output)); });
  });
  const url = `http://127.0.0.1:${port}`;
  const html = await (await fetch(url)).text();
  const token = html.match(/__RAI_WS_SESSION_TOKEN__\s*=\s*"([^"]+)"/)?.[1];
  assert.ok(token);
  return { child, url, token };
}
async function stop(proc) {
  const exited = new Promise(resolve => proc.once('exit', resolve));
  proc.kill('SIGKILL');
  await exited;
}
async function get(host) {
  const res = await fetch(`${host.url}/api/settings`, { headers: { 'X-RAI-Session-Token': host.token } });
  assert.equal(res.status, 200);
  return res.json();
}
async function post(host, body) {
  const snapshot = await get(host);
  return fetch(`${host.url}/api/settings`, { method: 'POST',
    headers: { 'X-RAI-Session-Token': host.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, expected_revision: snapshot.settings_revision }) });
}

test('snippet defaults migrate, custom names/prompts persist across bridge restart, invalid input is atomic, and reset works', async t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'rai-snippets-http-'));
  const port = await freePort();
  let host = await start(home, port);
  t.after(async () => { if (host?.child.exitCode === null) await stop(host.child); });
  const configFile = path.join(home, '.raistudio', 'assistant.json');
  assert.equal((await fetch(`${host.url}/api/settings`)).status, 401);
  assert.equal((await fetch(`${host.url}/api/skill-status?name=unavailable-test-skill`)).status, 401);
  const skill = await (await fetch(`${host.url}/api/skill-status?name=unavailable-test-skill`, {
    headers: { 'X-RAI-Session-Token': host.token }
  })).json();
  assert.equal(skill.availability, 'not_found_in_known_paths');
  assert.match(skill.message, /RAI does not install skills/);
  assert.deepEqual((await get(host)).snippets, DEFAULT_SNIPPETS);
  const custom = structuredClone(DEFAULT_SNIPPETS);
  custom.writing = { name: 'My writing', prompt: 'Exact first line; second part  with spaces' };
  custom.analysis = { name: 'My analysis', prompt: 'Exact analysis line; no data edits' };
  assert.equal((await post(host, { snippets: custom })).status, 200);
  assert.deepEqual((await get(host)).snippets, custom);
  assert.deepEqual(JSON.parse(readFileSync(configFile, 'utf8')).snippets, custom);
  const five = {
    writing: custom.writing,
    analysis: custom.analysis,
    's-aaaaaaaa': { name: 'Third', prompt: 'Third line' },
    's-bbbbbbbb': { name: 'Fourth', prompt: 'Fourth line' },
    's-cccccccc': { name: 'Fifth', prompt: 'Fifth line' }
  };
  const reordered = Object.fromEntries(Object.entries(five).reverse());
  assert.equal((await post(host, { snippets: reordered })).status, 200);
  assert.deepEqual(Object.keys((await get(host)).snippets), Object.keys(reordered));
  assert.equal((await post(host, { snippets: { ...five, 's-dddddddd': { name: 'Sixth', prompt: 'Sixth line' } } })).status, 400);
  assert.equal((await post(host, { snippets: {} })).status, 200);
  assert.deepEqual((await get(host)).snippets, {});
  assert.equal((await post(host, { snippets: custom, autoApproveReadOnly: false, caffeinate: false })).status, 200);
  const compatBytes = readFileSync(configFile);
  const compatMtime = statSync(configFile, { bigint: true }).mtimeNs;
  assert.equal(JSON.parse(compatBytes).autoApproveReadOnly, false);
  const approved = await get(host);
  assert.equal(approved.autoApproveReadOnly, true);
  assert.equal(approved.settings_revision, createHash('sha256').update(compatBytes).digest('hex'));
  assert.equal((await get(host)).caffeinate, false);
  assert.deepEqual(readFileSync(configFile), compatBytes);
  assert.equal(statSync(configFile, { bigint: true }).mtimeNs, compatMtime);
  assert.equal((await post(host, { autoApproveReadOnly: 'false' })).status, 400);
  assert.equal((await get(host)).autoApproveReadOnly, true);
  assert.deepEqual(readFileSync(configFile), compatBytes);
  assert.equal(statSync(configFile, { bigint: true }).mtimeNs, compatMtime);
  const before = readFileSync(configFile, 'utf8');
  const invalid = structuredClone(custom);
  invalid.analysis.prompt = '\n  ';
  assert.equal((await post(host, { snippets: invalid })).status, 400);
  assert.equal(readFileSync(configFile, 'utf8'), before);
  assert.equal((await post(host, { snippets: { ...custom, writing: { ...custom.writing, name: 'bad\nname' } } })).status, 400);
  assert.equal(readFileSync(configFile, 'utf8'), before);
  assert.equal((await post(host, { provider: 'codex' })).status, 200);
  assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).autoApproveReadOnly, false);
  assert.deepEqual((await get(host)).snippets, custom);
  const global = 'Every RAI harness receives this once\nGreek Ω and  two spaces';
  assert.equal((await post(host, { globalPrompt: global })).status, 200);
  assert.equal((await get(host)).globalPrompt, global);
  assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).autoApproveReadOnly, false);
  const priorGlobal = readFileSync(configFile, 'utf8');
  assert.equal((await post(host, { globalPrompt: 'injected\x1b[201~' })).status, 400);
  assert.equal(readFileSync(configFile, 'utf8'), priorGlobal);
  await stop(host.child);
  host = await start(home, port);
  assert.equal((await get(host)).provider, 'codex');
  assert.equal((await get(host)).globalPrompt, global);
  assert.deepEqual((await get(host)).snippets, custom);
  const restarted = await get(host);
  assert.equal(restarted.autoApproveReadOnly, true);
  assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).autoApproveReadOnly, false);
  assert.equal(restarted.settings_revision, createHash('sha256').update(readFileSync(configFile)).digest('hex'));
  assert.equal((await post(host, { snippets: structuredClone(DEFAULT_SNIPPETS) })).status, 200);
  assert.deepEqual((await get(host)).snippets, DEFAULT_SNIPPETS);
  assert.equal((await post(host, { globalPrompt: '' })).status, 200);
  assert.equal((await get(host)).globalPrompt, '');
});

test('300-code-point API edits preserve legacy text and unrelated saves atomically', async t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'rai-snippets-limit-'));
  const dir = path.join(home, '.raistudio');
  mkdirSync(dir);
  const file = path.join(dir, 'assistant.json');
  const legacy = { writing: { name: 'My legacy', prompt: 'Legacy\n' + '😀'.repeat(20000) } };
  writeFileSync(file, JSON.stringify({ provider: 'claude', providers: {}, snippets: legacy }));
  const host = await start(home, await freePort());
  t.after(async () => { if (host.child.exitCode === null) await stop(host.child); });
  assert.deepEqual((await get(host)).snippets, legacy);
  assert.equal((await post(host, { globalPrompt: 'g'.repeat(1000) })).status, 200);
  assert.equal((await get(host)).globalPrompt.length, 1000);
  assert.equal((await post(host, { snippets: legacy, theme: 'light' })).status, 413);
  assert.equal((await post(host, { snippets: { writing: { name: 'My legacy' } }, theme: 'light' })).status, 200);
  assert.equal((await post(host, { snippets: { 's-12345678': { name: 'Unknown' } } })).status, 400);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).snippets, legacy);
  const before = readFileSync(file, 'utf8');
  for (const prompt of ['😀'.repeat(301), 'new\nlines']) {
    const res = await post(host, { snippets: { writing: { name: 'My legacy', prompt } }, stored: true });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /300|one line/);
    assert.equal(readFileSync(file, 'utf8'), before);
  }
  const shortened = { writing: { name: 'My legacy', prompt: '😀'.repeat(300) } };
  assert.equal((await post(host, { snippets: shortened })).status, 200);
  assert.deepEqual((await get(host)).snippets, shortened);
});

for (const scenario of ['unauthorized', 'oversized', 'malformed', 'stale', 'invalid']) {
  test(`rejected ${scenario} POST cannot migrate externally replaced pristine defaults`, async t => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'rai-snippets-rejected-'));
    const host = await start(home, await freePort());
    t.after(async () => { if (host.child.exitCode === null) await stop(host.child); });
    const file = path.join(home, '.raistudio', 'assistant.json');
    // Place actual old shipped settings after startup. No GET may migrate them first.
    const raw = Buffer.from(JSON.stringify({ provider: 'claude', providers: {},
      snippets: LEGACY_DEFAULT_SNIPPETS }, null, 2) + '\n');
    writeFileSync(file, raw);
    const mtime = statSync(file, { bigint: true }).mtimeNs;
    const revision = createHash('sha256').update(raw).digest('hex');
    const body = scenario === 'stale' ? { expected_revision: 'stale', theme: 'light' }
      : { expected_revision: revision, snippets: { writing: { name: 'Writing review', prompt: 'x'.repeat(301) } } };
    const headers = { 'Content-Type': 'application/json' };
    if (scenario !== 'unauthorized') headers['X-RAI-Session-Token'] = host.token;
    const payload = scenario === 'malformed' ? '{' : scenario === 'oversized'
      ? JSON.stringify({ globalPrompt: 'x'.repeat(65 * 1024) }) : JSON.stringify(body);
    const response = await fetch(`${host.url}/api/settings`, { method: 'POST', headers, body: payload });
    assert.equal(response.status, { unauthorized: 401, oversized: 413, malformed: 400, stale: 409, invalid: 400 }[scenario]);
    assert.deepEqual(readFileSync(file), raw, 'rejected POST must preserve exact owner bytes');
    assert.equal(statSync(file, { bigint: true }).mtimeNs, mtime);
    // Also pass several existing250ms file-watch intervals: refresh is not a writer.
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.deepEqual(readFileSync(file), raw, 'background refresh must preserve exact owner bytes');
    assert.equal(statSync(file, { bigint: true }).mtimeNs, mtime);
  });
}

test('startup and GET migrate; current raw revision saves and GET migration conflicts safely', async t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'rai-snippets-migration-witness-'));
  const dir = path.join(home, '.raistudio');
  mkdirSync(dir);
  const file = path.join(dir, 'assistant.json');
  const raw = Buffer.from(JSON.stringify({ provider: 'claude', providers: {},
    snippets: LEGACY_DEFAULT_SNIPPETS }, null, 2) + '\n');
  writeFileSync(file, raw);
  const host = await start(home, await freePort());
  t.after(async () => { if (host.child.exitCode === null) await stop(host.child); });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).snippets, DEFAULT_SNIPPETS);
  const revision = createHash('sha256').update(raw).digest('hex');
  writeFileSync(file, raw);
  const migrated = await get(host);
  const afterGet = readFileSync(file);
  assert.deepEqual(migrated.snippets, DEFAULT_SNIPPETS);
  assert.deepEqual(JSON.parse(afterGet).snippets, DEFAULT_SNIPPETS);
  assert.equal(migrated.settings_revision, createHash('sha256').update(afterGet).digest('hex'));
  assert.notEqual(migrated.settings_revision, revision);
  const headers = { 'X-RAI-Session-Token': host.token, 'Content-Type': 'application/json' };
  const stale = await fetch(`${host.url}/api/settings`, { method: 'POST', headers,
    body: JSON.stringify({ expected_revision: revision, theme: 'light' }) });
  assert.equal(stale.status, 409);
  assert.deepEqual(readFileSync(file), afterGet, 'GET migration must fence a POST holding the old revision');
  writeFileSync(file, raw);
  const saved = await fetch(`${host.url}/api/settings`, { method: 'POST', headers,
    body: JSON.stringify({ expected_revision: revision, theme: 'light' }) });
  assert.equal(saved.status, 200);
  const ack = await saved.json();
  const committed = readFileSync(file);
  assert.equal(JSON.parse(committed).theme, 'light');
  assert.deepEqual(JSON.parse(committed).snippets, DEFAULT_SNIPPETS);
  assert.equal(ack.settings_revision, createHash('sha256').update(committed).digest('hex'));
  assert.deepEqual(ack.snippets, DEFAULT_SNIPPETS);
});

test('legacy preferences migrate without loss; corrupt bytes are backed up and recovery is visible', async t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'rai-snippets-migrate-'));
  const configDir = path.join(home, '.raistudio');
  const configFile = path.join(configDir, 'assistant.json');
  mkdirSync(configDir);
  writeFileSync(configFile, JSON.stringify({ provider: 'claude', providers: {}, customField: 'preserve-me' }));
  const port = await freePort();
  let host = await start(home, port);
  t.after(async () => { if (host?.child.exitCode === null) await stop(host.child); });
  const migrated = await get(host);
  assert.equal(migrated.settingsVersion, 2);
  assert.equal(migrated.globalPrompt, '');
  assert.deepEqual(migrated.snippets, DEFAULT_SNIPPETS);
  assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).customField, 'preserve-me');
  await stop(host.child);
  const broken = '{"snippets": {"writing": {"prompt": "recover my research"}';
  writeFileSync(configFile, broken);
  host = await start(home, port);
  const cfg = await get(host);
  assert.match(cfg.settingsRecovery, /Original remains at/);
  const backups = readdirSync(configDir).filter(name => name.startsWith('assistant.json.recovery-'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(configFile, 'utf8'), broken); // No automatic overwrite.
  assert.equal(readFileSync(path.join(configDir, backups[0]), 'utf8'), broken);
  assert.equal(statSync(path.join(configDir, backups[0])).mode & 0o777, 0o600);
  assert.deepEqual(cfg.snippets, DEFAULT_SNIPPETS);
  assert.equal((await post(host, { globalPrompt: 'explicit recovery' })).status, 200);
  assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).globalPrompt, 'explicit recovery');
  await stop(host.child);
  host = null;
  writeFileSync(configFile, broken);
  writeFileSync(path.join(configDir, backups[0]), 'tampered backup');
  await assert.rejects(start(home, port), /recovery backup collision/);
  assert.equal(readFileSync(configFile, 'utf8'), broken);
});


test('RAI saving is always on: default, ignored false, invalid types, any stored legacy value', async t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'rai-save-http-'));
  const port = await freePort();
  let host = await start(home, port);
  t.after(async () => { if (host?.child.exitCode === null) await stop(host.child); });
  const file = path.join(home, '.raistudio', 'assistant.json');
  assert.equal((await get(host)).saveOnEdit, true, 'absent defaults ON');
  assert.equal((await post(host, { saveOnEdit: false })).status, 200);
  assert.equal((await get(host)).saveOnEdit, true, 'a posted false is ignored');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).saveOnEdit, true, 'stored value stays true');
  const before = readFileSync(file);
  for (const saveOnEdit of ['false', 0, null, [], {}]) {
    assert.equal((await post(host, { saveOnEdit })).status, 400, 'invalid type rejected');
    assert.deepEqual(readFileSync(file), before, 'rejection preserves bytes');
  }
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  for (const legacy of [false, 'false', 0, null, 'garbage']) {
    await stop(host.child);
    writeFileSync(file, JSON.stringify({ ...stored, saveOnEdit: legacy }, null, 2), { mode: 0o600 });
    host = await start(home, port);
    assert.equal((await get(host)).saveOnEdit, true, `a stored ${JSON.stringify(legacy)} from an older build reads as ON`);
  }
});
