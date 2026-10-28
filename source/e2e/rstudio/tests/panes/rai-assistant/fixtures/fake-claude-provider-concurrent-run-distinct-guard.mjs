#!/usr/bin/env node
// Regression guard for QUEUE DEPTH on the single-in-flight Console run
// contract. fake-claude-provider-concurrent-run-guard.mjs already covers the
// one-at-a-time probes: one different proposal mid-run is refused, and the
// same proposal mid-run dedupes onto its run. Neither of those can answer the
// question this fixture exists for -- what happens to a BURST of distinct
// proposals, fired together, none of them a retry of anything.
//
// That is the shape an eager audit produces: the assistant reads chunk 1's
// submission, decides chunks 2, 3 and 4 are independent, and fires all three
// without waiting. If the native side held even a one-slot queue, one of them
// would execute later, unattended, with no caller polling it -- side effects
// landing in .GlobalEnv from a run nobody is watching.
//
// OBSERVED NATIVE BEHAVIOR (recorded here rather than assumed; the source of
// truth is SessionRaiAssistant.cpp handleConsoleRunRequest):
//
//   * Queue depth is ZERO. All three concurrent distinct proposals are
//     refused with {"status":"busy","message":"a console run is already in
//     progress"} and no run_id. Not one of them is queued, deferred, or
//     retried later -- after the holding run settles, none of their bindings
//     exists until the caller explicitly resubmits.
//   * The refusals come from the RESERVATION path, not the digest-dedupe
//     path, and the two are distinguishable on the wire: the dedupe branch
//     builds a json::Object that carries session_id, while the reservation
//     failure writes a hardcoded body with no session_id at all. Recording
//     that field is what proves these were rejected as genuinely new
//     proposals rather than mistaken for retries of each other.
//   * The refusals are decided in C++ before re-entering R, so all three come
//     back promptly rather than blocking behind the running code.
//   * Nothing is poisoned: after the slot frees, all three submit and run
//     normally, in the order the caller resubmits them.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

const HOLD_SECONDS = 12;
// Sys.sleep has no approved effect contract. The hold uses neutral calls only.
export const FIRST_CODE =
  `{ start <- as.numeric(Sys.time()); repeat { if (as.numeric(Sys.time()) - start >= ${HOLD_SECONDS}) break }; rai_burst_first <- 1L; print('RAI_BURST_FIRST_DONE') }`;
// Three genuinely distinct proposals: different bindings, different values,
// different sentinels, so no two of them can share a fingerprint and be
// collapsed by the bridge's proposal identity cache.
export const BURST = [
  { name: 'rai_burst_alpha', code: `{ rai_burst_alpha <- 2L; print('RAI_BURST_ALPHA_DONE') }`, sentinel: 'RAI_BURST_ALPHA_DONE', value: 2 },
  { name: 'rai_burst_bravo', code: `{ rai_burst_bravo <- 3L; print('RAI_BURST_BRAVO_DONE') }`, sentinel: 'RAI_BURST_BRAVO_DONE', value: 3 },
  { name: 'rai_burst_charlie', code: `{ rai_burst_charlie <- 4L; print('RAI_BURST_CHARLIE_DONE') }`, sentinel: 'RAI_BURST_CHARLIE_DONE', value: 4 },
];
const ALL_NAMES = ['rai_burst_first', ...BURST.map((entry) => entry.name)];

function findArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configPath = findArg('--mcp-config');
const stateDir = findArg('--test-state-dir');
if (!configPath || !stateDir)
  throw new Error('concurrent-run-distinct-guard provider requires --mcp-config and --test-state-dir');

mkdirSync(stateDir, { recursive: true });
writeFileSync(`${stateDir}/provider.pid`, String(process.pid));

function log(line) {
  process.stdout.write(`${line}\n`);
  appendFileSync(`${stateDir}/provider.log`, `${line}\n`);
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const server = sessionMcpServer(config);
if (!server)
  throw new Error('MCP config has no rai server');

const child = spawn(server.command, server.args ?? [], {
  env: { ...process.env, ...(server.env ?? {}) },
  stdio: ['pipe', 'pipe', 'inherit'],
});
writeFileSync(`${stateDir}/mcp.pid`, String(child.pid));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
    process.exit(0);
  });
}

const pending = new Map();
let nextId = 1;
readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
  try {
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  } catch {
    // MCP is JSON lines; ignore non-protocol diagnostics.
  }
});

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function textToolResult(message) {
  const text = message.result?.content?.[0]?.text;
  if (text) return JSON.parse(text);
  return { status: 'error', error: message.error?.message ?? 'MCP request failed' };
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const transcript = [];
const pollLog = [];

async function toolCall(name, args) {
  const response = await call('tools/call', { name, arguments: args });
  const result = textToolResult(response);
  transcript.push({ tool: name, arguments: args, response, result });
  return { response, result };
}

// One run_r attempt, reported exactly as the native side answered it, with no
// retry loop: the whole point is to capture the FIRST answer to a concurrent
// submission. session_id presence is recorded because it is what distinguishes
// the reservation-failure rejection from the digest-dedupe one.
async function submitOnce(label, code) {
  const startedAt = Date.now();
  const attempt = await toolCall('run_r', { proposal: { language: 'R', target: 'console', code } });
  return {
    label,
    elapsed_ms: Date.now() - startedAt,
    status: attempt.result.status ?? null,
    run_id: attempt.result.run_id ?? null,
    message: attempt.result.message ?? null,
    has_session_id: Object.prototype.hasOwnProperty.call(attempt.result, 'session_id'),
    error: attempt.result.error ?? null,
  };
}

async function submitAndQueue(label, code) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const attempt = await submitOnce(label, code);
    if (attempt.status === 'approval_required' || attempt.status === 'busy') {
      await sleep(200);
      continue;
    }
    return attempt;
  }
  throw new Error(`timed out waiting for a queue decision on: ${code}`);
}

async function readRun(runId) {
  const readResult = await toolCall('get_run_result', { run_id: runId });
  pollLog.push({ run_id: runId, status: readResult.result.status });
  return readResult.result;
}

async function awaitSettled(runId, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await readRun(runId);
    if (result.status === 'pending' || result.status === 'running') {
      await sleep(400);
      continue;
    }
    return result;
  }
  throw new Error(`timed out waiting for get_run_result(${runId}) to settle`);
}

async function environmentFound(names) {
  const summary = await toolCall('get_environment_summary', { object_names: names });
  const objects = summary.result.objects ?? [];
  return Object.fromEntries(names.map((name) =>
    [name, Boolean(objects.find((object) => object.name === name)?.found)]));
}

async function main() {
  transcript.push({ method: 'initialize', response: await call('initialize', { protocolVersion: '2024-11-05' }) });
  const listed = await call('tools/list', {});
  const names = listed.result?.tools?.map((entry) => entry.name) ?? [];
  for (const required of ['run_r', 'get_run_result', 'get_environment_summary']) {
    if (!names.includes(required))
      throw new Error(`concurrent-run-distinct-guard workflow requires tool "${required}", got: ${JSON.stringify(names)}`);
  }

  // --- The holding run takes the slot for HOLD_SECONDS. --------------------
  const firstSubmit = await submitAndQueue('first', FIRST_CODE);
  if (!firstSubmit.run_id)
    throw new Error(`the holding run_r did not queue: ${JSON.stringify(firstSubmit)}`);
  const firstRunId = firstSubmit.run_id;

  // Confirm it really is still in flight before the burst -- otherwise a fast
  // machine could make this fixture assert nothing at all.
  const beforeBurst = await readRun(firstRunId);
  if (beforeBurst.status !== 'pending' && beforeBurst.status !== 'running')
    throw new Error(
      `the holding run settled before the burst (status=${beforeBurst.status}) -- ` +
      `it is not slow enough to prove queue depth; increase HOLD_SECONDS`);

  // --- The probe: three DISTINCT proposals fired together, not one after
  // another. Promise.all puts all three on the wire before any of them has
  // been answered, which is the rapid-succession case a serial loop cannot
  // reproduce. -------------------------------------------------------------
  const burstStartedAt = Date.now();
  const burstAttempts = await Promise.all(
    BURST.map((entry) => submitOnce(entry.name, entry.code)));
  const burstSpanMs = Date.now() - burstStartedAt;

  // --- The holding run is STILL in flight after the burst, so every one of
  // those three answers was genuinely concurrent with it. -------------------
  const afterBurst = await readRun(firstRunId);

  // --- Ground truth during the hold: none of the burst bindings exists. ----
  const environmentDuringHold = await environmentFound(ALL_NAMES);

  const firstResult = await awaitSettled(firstRunId);
  if (firstResult.status !== 'ok')
    throw new Error(`the holding run did not succeed: ${JSON.stringify(firstResult)}`);
  if (!String(firstResult.stdout ?? '').includes('RAI_BURST_FIRST_DONE'))
    throw new Error(`the holding run output is missing its sentinel: ${JSON.stringify(firstResult)}`);

  // --- The queue-depth assertion. If ANY depth existed, a rejected proposal
  // would run here, unattended, once the slot freed. Read immediately after
  // the holding run settles, then again after a grace window, so a deferred
  // execution has a real chance to show up rather than being outrun. -------
  const environmentAfterSettle = await environmentFound(ALL_NAMES);
  await sleep(3000);
  const environmentAfterGrace = await environmentFound(ALL_NAMES);

  // --- Nothing is poisoned: each refused proposal submits and runs normally
  // now, in the order the caller resubmits them. ---------------------------
  const retries = [];
  for (const entry of BURST) {
    const retryAttempt = await submitAndQueue(`${entry.name}-retry`, entry.code);
    if (!retryAttempt.run_id)
      throw new Error(`${entry.name} did not queue after the slot freed: ${JSON.stringify(retryAttempt)}`);
    const result = await awaitSettled(retryAttempt.run_id);
    if (result.status !== 'ok')
      throw new Error(`${entry.name} did not succeed once serialized: ${JSON.stringify(result)}`);
    if (!String(result.stdout ?? '').includes(entry.sentinel))
      throw new Error(`${entry.name} output is missing its sentinel: ${JSON.stringify(result)}`);
    retries.push({ name: entry.name, attempt: retryAttempt, status: result.status, stdout: result.stdout ?? null });
  }

  const finalEnvironment = await environmentFound(ALL_NAMES);

  writeFileSync(`${stateDir}/concurrent-distinct-data.json`, JSON.stringify({
    hold_seconds: HOLD_SECONDS,
    first_run_id: firstRunId,
    first_submit: firstSubmit,
    status_before_burst: beforeBurst.status,
    burst_attempts: burstAttempts,
    burst_span_ms: burstSpanMs,
    status_after_burst: afterBurst.status,
    environment_during_hold: environmentDuringHold,
    first_result: firstResult,
    environment_after_settle: environmentAfterSettle,
    environment_after_grace: environmentAfterGrace,
    retries,
    final_environment: finalEnvironment,
    poll_log: pollLog,
    transcript,
  }, null, 2));
  log('[fake-provider-concurrent-run-distinct-guard] data written');

  await sleep(30000);
}

main().catch((error) => {
  log(`[fake-provider-concurrent-run-distinct-guard] fatal: ${error.stack ?? error}`);
  writeFileSync(`${stateDir}/error.txt`, String(error?.stack ?? error));
  process.exitCode = 1;
}).finally(() => child.kill());
