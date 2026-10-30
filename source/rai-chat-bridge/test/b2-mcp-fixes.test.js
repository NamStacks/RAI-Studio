import { proofConfig } from './helpers/callback-proof-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createProposalIdentityCache, handleRequest as rawHandleRequest, monitorConsoleRun as rawMonitorConsoleRun
} from '../rai-native-mcp.js';
import { validateRConsoleProposal } from '../rcode-distiller.js';

const handleRequest = (request, config) => rawHandleRequest(request, proofConfig(config));
const monitorConsoleRun = (runId, config) => rawMonitorConsoleRun(runId, proofConfig(config));
const HEALTH_URL = 'http://127.0.0.1:19091/health';
const TOKEN = 'mcp-test-token';
const proposal = code => ({ language: 'R', target: 'console', code });
const digest = value => createHash('sha256').update(value).digest('hex');

async function callTool(name, args, config) {
  const response = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, config);
  if (response.error) throw new Error(response.error.message);
  return JSON.parse(response.result.content[0].text);
}

function runFetch(answers) {
  const ids = [];
  const fetch = async (url, options = {}) => {
    const name = new URL(url).pathname.slice(1);
    if (name === 'run') {
      ids.push(new URLSearchParams(options.body).get('proposal_id'));
      const answer = answers.shift();
      return { ok: true, status: 200, json: async () => answer };
    }
    if (name === 'health') return { ok: true, status: 200, json: async () => ({ session_id: 'session-a' }) };
    throw new Error(`unexpected endpoint ${name}`);
  };
  return { fetch, ids };
}

const runConfig = fetch => ({ token: TOKEN, healthUrl: HEALTH_URL, fetch, proposalIdCache: createProposalIdentityCache() });

test('a refused proposal without a run id does not keep its spent proposal id', async () => {
  const { fetch, ids } = runFetch([
    { status: 'error', policy: 'refused', message: 'refused' },
    { status: 'queued', run_id: 'run-mcp-1', session_id: 'session-a' }
  ]);
  const config = runConfig(fetch);
  const args = { proposal: proposal('out <- 1 + 1') };
  assert.equal((await callTool('run_r', args, config)).status, 'error');
  assert.equal((await callTool('run_r', args, config)).status, 'queued');
  assert.notEqual(ids[0], ids[1]);
});

test('a stored failed decision does not keep its spent proposal id', async () => {
  const { fetch, ids } = runFetch([
    { status: 'error', message: 'approval request failed; submit a fresh proposal', enqueue: 'no' },
    { status: 'queued', run_id: 'run-mcp-2', session_id: 'session-a' }
  ]);
  const config = runConfig(fetch);
  const args = { proposal: proposal('out <- 2 + 2') };
  await callTool('run_r', args, config);
  await callTool('run_r', args, config);
  assert.notEqual(ids[0], ids[1]);
});

test('a stored approval decline keeps its proposal id', async () => {
  const { fetch, ids } = runFetch([
    { status: 'error', message: 'blocked: approval declined' },
    { status: 'error', message: 'blocked: approval declined' }
  ]);
  const config = runConfig(fetch);
  const args = { proposal: proposal('out <- 6 + 6') };
  await callTool('run_r', args, config);
  await callTool('run_r', args, config);
  assert.equal(ids[0], ids[1]);
});

test('an ok replay of an already queued run keeps the proposal id for transport retries', async () => {
  const { fetch, ids } = runFetch([
    { status: 'queued', run_id: 'run-mcp-3', session_id: 'session-a' },
    { status: 'ok', run_id: 'run-mcp-3', session_id: 'session-a', enqueue: 'no' },
    { status: 'ok', run_id: 'run-mcp-3', session_id: 'session-a', enqueue: 'no' }
  ]);
  const config = runConfig(fetch);
  const args = { proposal: proposal('out <- 3 + 3') };
  await callTool('run_r', args, config);
  await callTool('run_r', args, config);
  await callTool('run_r', args, config);
  assert.equal(new Set(ids).size, 1);
});

test('a pending approval keeps its proposal id', async () => {
  const { fetch, ids } = runFetch([{ status: 'approval_required' }, { status: 'approval_required' }]);
  const config = runConfig(fetch);
  const args = { proposal: proposal('out <- 4 + 4') };
  await callTool('run_r', args, config);
  await callTool('run_r', args, config);
  assert.equal(ids[0], ids[1]);
});

test('a busy Console answer keeps the native message and the proposal id', async () => {
  const { fetch, ids } = runFetch([
    { status: 'busy', message: 'a console run is already in progress' },
    { status: 'queued', run_id: 'run-mcp-5', session_id: 'session-a' }
  ]);
  const config = runConfig(fetch);
  const args = { proposal: proposal('out <- 5 + 5') };
  const busy = await callTool('run_r', args, config);
  assert.equal(busy.status, 'busy');
  assert.equal(busy.message, 'a console run is already in progress');
  await callTool('run_r', args, config);
  assert.equal(ids[0], ids[1]);
});

function monitorOptions(overrides = {}) {
  const state = { time: 0, snapshots: [] };
  const options = {
    token: TOKEN, healthUrl: HEALTH_URL, runSessionRegistry: { sessionFor: () => 'session-a' },
    now: () => state.time, sleep: async ms => { state.time += ms; },
    pollIntervalMs: 5000, monitorTimeoutMs: 60000,
    onSnapshot: snapshot => { state.snapshots.push(snapshot); },
    ...overrides
  };
  return { state, options };
}

test('monitor rides out a Restart R outage and reports session_restarted', async () => {
  const { state, options } = monitorOptions();
  options.fetch = async url => {
    const name = new URL(url).pathname.slice(1);
    if (state.time < 3000) throw new TypeError('fetch failed');
    if (name === 'health') return { ok: true, status: 200, json: async () => ({ session_id: 'session-b' }) };
    throw new Error(`unexpected endpoint ${name}`);
  };
  const result = await monitorConsoleRun('run-mcp-restart', options);
  assert.equal(result.status, 'session_restarted');
  assert.equal(state.snapshots.at(-1).state, 'session_restarted');
});

test('monitor returns a readable unreachable result when the outage outlasts the window', async () => {
  const { state, options } = monitorOptions({ monitorTimeoutMs: 4000 });
  options.fetch = async () => { throw new TypeError('fetch failed'); };
  const result = await monitorConsoleRun('run-mcp-down', options);
  assert.equal(result.status, 'unreachable');
  assert.equal(result.run_id, 'run-mcp-down');
  assert.match(result.message, /unreachable/);
  assert.doesNotMatch(result.message, /fetch failed/);
  assert.equal(state.snapshots.at(-1).state, 'timed_out');
  assert.equal(state.snapshots.filter(snapshot => snapshot.state !== 'running').length, 1);
});

test('monitor gives up on a permanent outage after the unreachable limit even with a longer window', async () => {
  const { state, options } = monitorOptions({ monitorTimeoutMs: 600000 });
  options.fetch = async () => { throw new TypeError('fetch failed'); };
  const result = await monitorConsoleRun('run-mcp-gone', options);
  assert.equal(result.status, 'unreachable');
  assert.ok(state.time >= 60000 && state.time < 66000, `stopped at ${state.time} ms`);
  assert.equal(state.snapshots.at(-1).state, 'timed_out');
});

test('monitor rethrows a native rejected answer at once without retrying', async () => {
  const { state, options } = monitorOptions();
  let monitorCalls = 0;
  options.fetch = async url => {
    if (new URL(url).pathname !== '/monitor') return { ok: true, status: 200, json: async () => ({ session_id: 'session-a' }) };
    monitorCalls += 1;
    return { ok: false, status: 400, json: async () => ({ status: 'error', message: 'invalid run id' }) };
  };
  await assert.rejects(monitorConsoleRun('run-mcp-rejected', options), /native R session rejected monitor/);
  assert.equal(monitorCalls, 1);
  assert.equal(state.time, 0);
  assert.equal(state.snapshots.at(-1).state, 'timed_out');
});

test('monitor rethrows a native endpoint configuration error at once without retrying', async () => {
  const { state, options } = monitorOptions({ healthUrl: 'https://127.0.0.1:19091/health' });
  options.fetch = async () => { throw new Error('must not be called'); };
  await assert.rejects(monitorConsoleRun('run-mcp-config', options), /endpoint configuration is invalid/);
  assert.equal(state.time, 0);
});

test('monitor recovers after a transient failure and still settles normally', async () => {
  const { state, options } = monitorOptions();
  let monitorCalls = 0;
  options.fetch = async url => {
    if (new URL(url).pathname !== '/monitor') return { ok: true, status: 200, json: async () => ({ session_id: 'session-a' }) };
    monitorCalls += 1;
    if (monitorCalls === 1) throw new TypeError('fetch failed');
    return { ok: true, status: 200, json: async () => ({ status: 'ok', run_id: 'run-mcp-ok', output_bytes: 4, stdout: 'done' }) };
  };
  const result = await monitorConsoleRun('run-mcp-ok', options);
  assert.equal(result.status, 'ok');
  assert.equal(state.snapshots.at(-1).state, 'settled');
});

test('monitor emits a terminal snapshot when it throws', async () => {
  const { state, options } = monitorOptions();
  options.fetch = async url => {
    if (new URL(url).pathname !== '/monitor') return { ok: true, status: 200, json: async () => ({ session_id: 'session-a' }) };
    return { ok: true, status: 200, json: async () => ({ status: 'running', run_id: 'run-other' }) };
  };
  await assert.rejects(monitorConsoleRun('run-mcp-bad', options), /invalid monitor snapshot/);
  assert.equal(state.snapshots.length, 1);
  assert.equal(state.snapshots[0].state, 'timed_out');
});

test('monitor_console_run closes the inspector strip when the stored result read fails after not_running', async () => {
  const snapshots = [];
  const config = {
    token: TOKEN, healthUrl: HEALTH_URL, onSnapshot: snapshot => { snapshots.push(snapshot); },
    fetch: async url => {
      const name = new URL(url).pathname.slice(1);
      if (name === 'monitor') return { ok: true, status: 200, json: async () => ({ status: 'not_running', run_id: 'run-mcp-gone', output_bytes: 0 }) };
      if (name === 'result') throw new TypeError('fetch failed');
      return { ok: true, status: 200, json: async () => ({ session_id: 'session-a' }) };
    }
  };
  await assert.rejects(callTool('monitor_console_run', { run_id: 'run-mcp-gone', observation_ms: 1000 }, config), /fetch failed/);
  assert.equal(snapshots.at(-1).state, 'timed_out');
});

function auditHarness() {
  const native = { session_id: 'session-a', console_busy: false, console_epoch: '0', source_revision: '0', document: true, project: true, file_path: 'analysis.Rmd' };
  const calls = [];
  let healthCalls = 0;
  const config = { token: TOKEN, healthUrl: HEALTH_URL, fetch: async url => {
    const name = new URL(url).pathname.slice(1);
    calls.push(name);
    if (name === 'health') healthCalls += 1;
    const payload = {
      health: { ...native, session_id: native.sessionFor?.(healthCalls) ?? native.session_id, status: 'ok' },
      active_document: native.document ? { document_id: 'doc-a', path: 'analysis.Rmd' } : {},
      project_context: { project_active: native.project, root_name: 'fixture' },
      document: { document_id: 'doc-a', audit_revision: native.source_revision, contents: 'x <- 42', path: 'analysis.Rmd', ...(native.paged ? { next_offset: 7 } : {}) },
      file: { path: native.file_path, text: 'x <- 42', audit_revision: '0' },
      environment: { bindings: [{ name: 'x', binding: 'value' }], total_count: 1, truncated: false }
    }[name];
    if (!payload) throw new Error(`unexpected endpoint ${name}`);
    return { ok: true, status: 200, json: async () => payload };
  } };
  return { native, calls, healthCalls: () => healthCalls, call: (name, args = {}) => callTool(name, args, config) };
}

test('a read after the audited document disappears still succeeds and invalidates the audit', async () => {
  const h = auditHarness();
  const audit = await h.call('audit_session', { action: 'start' });
  h.native.document = false;
  const read = await h.call('read_project_file', { path: 'analysis.Rmd' });
  assert.equal(read.text, 'x <- 42');
  assert.equal((await h.call('audit_session', { action: 'status', audit_id: audit.audit_id })).status, 'invalidated');
});

test('a read with no active project still succeeds and invalidates the audit', async () => {
  const h = auditHarness();
  const audit = await h.call('audit_session', { action: 'start' });
  h.native.project = false;
  const read = await h.call('get_environment_summary');
  assert.equal(read.total_count, 1);
  assert.equal((await h.call('audit_session', { action: 'status', audit_id: audit.audit_id })).status, 'invalidated');
});

test('a read whose session changes mid-identity-check still succeeds and invalidates the audit', async () => {
  const h = auditHarness();
  const audit = await h.call('audit_session', { action: 'start' });
  const flipAt = h.healthCalls() + 2;
  h.native.sessionFor = call => (call === flipAt ? 'session-b' : 'session-a');
  const read = await h.call('read_project_file', { path: 'analysis.Rmd' });
  assert.equal(read.text, 'x <- 42');
  assert.equal((await h.call('audit_session', { action: 'status', audit_id: audit.audit_id })).status, 'invalidated');
});

test('a read while the Console is busy still succeeds without audit evidence and keeps the audit active', async () => {
  const h = auditHarness();
  const audit = await h.call('audit_session', { action: 'start' });
  h.native.console_busy = true;
  const read = await h.call('read_project_file', { path: 'analysis.Rmd' });
  assert.equal(read.text, 'x <- 42');
  assert.equal(read.audit_evidence_id, undefined);
  assert.match(read.audit_evidence_unavailable, /coverage incomplete/);
  assert.equal((await h.call('audit_session', { action: 'status', audit_id: audit.audit_id })).status, 'active');
  h.native.console_busy = false;
  assert.ok((await h.call('read_project_file', { path: 'analysis.Rmd' })).audit_evidence_id);
});

test('a read keeps the real identity error when the document digest is unavailable', async () => {
  const h = auditHarness();
  const audit = await h.call('audit_session', { action: 'start' });
  h.native.paged = true;
  await assert.rejects(h.call('read_project_file', { path: 'analysis.Rmd' }), /native full-buffer digest required/);
  assert.equal((await h.call('audit_session', { action: 'status', audit_id: audit.audit_id })).status, 'active');
});

test('a checkpoint that fails while recording releases its phase claim', async () => {
  const h = auditHarness();
  const audit = await h.call('audit_session', { action: 'start' });
  h.native.file_path = 'a'.repeat(600);
  const bad = await h.call('read_project_file', { path: 'analysis.Rmd' });
  assert.ok(bad.audit_evidence_id);
  await assert.rejects(h.call('audit_session', { action: 'checkpoint', audit_id: audit.audit_id, phase: 0, evidence_ids: [bad.audit_evidence_id], checks: ['x <- 42'] }), /invalid evidence file/);
  const good = await h.call('get_environment_summary');
  const next = await h.call('audit_session', { action: 'checkpoint', audit_id: audit.audit_id, phase: 0, evidence_ids: [good.audit_evidence_id], checks: ['"truncated":false'] });
  assert.equal(next.current_phase, 1);
});

test('a failed checkpoint leaves no evidence rows behind for the retry to duplicate', async () => {
  const h = auditHarness();
  const audit = await h.call('audit_session', { action: 'start' });
  const first = await h.call('get_environment_summary');
  h.native.file_path = 'a'.repeat(600);
  const bad = await h.call('read_project_file', { path: 'analysis.Rmd' });
  await assert.rejects(h.call('audit_session', { action: 'checkpoint', audit_id: audit.audit_id, phase: 0, evidence_ids: [first.audit_evidence_id, bad.audit_evidence_id], checks: ['x <- 42'] }), /invalid evidence file/);
  const afterFailure = await h.call('audit_session', { action: 'status', audit_id: audit.audit_id });
  assert.equal(afterFailure.evidence.length, 0);
  const second = await h.call('get_environment_summary');
  const next = await h.call('audit_session', { action: 'checkpoint', audit_id: audit.audit_id, phase: 0, evidence_ids: [first.audit_evidence_id, second.audit_evidence_id], checks: ['"truncated":false'] });
  assert.equal(next.current_phase, 1);
  assert.equal(next.evidence.length, 2);
});

test('edit_document rejects lone surrogates and NUL before any native call', async () => {
  const calls = [];
  const config = { token: TOKEN, healthUrl: HEALTH_URL, fetch: async url => { calls.push(url); throw new Error('must not be called'); } };
  const document_id = 'doc-a';
  const expected_digest = digest('x');
  for (const args of [
    { document_id, contents: 'a\ud800b', expected_digest },
    { document_id, contents: 'a\0b', expected_digest },
    { document_id, expected_text: 'x', replacement: 'a\udc00b' },
    { document_id, expected_text: 'a\0b', replacement: 'y' },
    { document_id, expected_text: 'x', replacement: 'y', context_before: 'a\ud800', context_after: 'z' }
  ]) {
    await assert.rejects(callTool('edit_document', args, config), /surrogate|NUL|whole-buffer/);
  }
  assert.deepEqual(calls, []);
});

test('prose heuristic accepts valid R that starts with a dotted run, use or execute identifier', () => {
  for (const code of ['run.model <- lm(y ~ x, data = d)', 'use.names <- TRUE', 'execute.fn <- function(x) x', 'Run <- 3', 'use(x)']) {
    assert.equal(validateRConsoleProposal(proposal(code)), code);
  }
  assert.throws(() => validateRConsoleProposal(proposal('Please run 20 + 22')), /not the user request/);
  assert.throws(() => validateRConsoleProposal(proposal('run the analysis')), /not the user request/);
});

test('rai-audit skill guidance carries no triple backtick in code and no Wald p kept for a zero-event arm', () => {
  const text = readFileSync(fileURLToPath(new URL('../skills/rai-audit/scientific-checks.md', import.meta.url)), 'utf8');
  const lines = text.split('\n');
  let inCode = false;
  for (const line of lines) {
    if (/^```r\s*$/.test(line)) { inCode = true; continue; }
    if (inCode && /^```\s*$/.test(line)) { inCode = false; continue; }
    if (inCode) assert.ok(!line.includes('```'), line);
  }
  assert.doesNotMatch(text, /keep p, which/);
  assert.match(text, /Hauck-Donner/);
  assert.match(text, /log-rank, likelihood ratio or Firth/);
});

test('whole-file edit limits in the assistant guidance state the real bounds', () => {
  for (const file of ['../skills/rai-audit/SKILL.md', '../prompts/RAI-Assistant.md']) {
    const text = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    assert.doesNotMatch(text, /at most 1 MiB/, file);
    assert.match(text, /10 MiB reader bound/, file);
    assert.match(text, /within 4 MiB/, file);
  }
});
