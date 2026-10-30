#!/usr/bin/env node
// Regression guard for the single-in-flight Console run contract. Every other
// scripted fixture in this suite submits one run at a time and waits, so none
// of them exercises what happens when a second, DIFFERENT proposal arrives
// while a Console run is still holding the capture slot -- the exact shape of
// an audit loop that fires the next chunk before reading the previous one's
// result.
//
// OBSERVED NATIVE BEHAVIOR (this fixture records it rather than assuming it;
// the source of truth is SessionRaiAssistant.cpp handleConsoleRunRequest):
//
//   * A DIFFERENT proposal submitted while a run is in flight is REJECTED,
//     not queued and not serialized. raiReserveConsoleCapture fails because
//     the slot is not Idle, and /run answers
//     {"status":"busy","message":"a console run is already in progress"}
//     with no run_id. The rejection is decided in C++ before re-entering R,
//     so it comes back promptly rather than blocking behind the running code.
//   * The SAME proposal resubmitted while in flight is deduped onto the run
//     it already created -- status "queued" with the original run_id -- so a
//     client retrying its own proposal never spawns a second live run.
//   * The rejected proposal is not remembered anywhere: once the first run
//     settles, resubmitting it registers a fresh run and executes normally.
//
// The invariant that matters either way is that the second chunk's side
// effects never appear while the first is still running.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

const HOLD_SECONDS = 8;
// Sys.sleep has no approved effect contract. The hold uses neutral calls only.
export const FIRST_CODE =
  `{ start <- as.numeric(Sys.time()); repeat { if (as.numeric(Sys.time()) - start >= ${HOLD_SECONDS}) break }; rai_guard_first <- 1L; print('RAI_GUARD_FIRST_DONE') }`;
export const SECOND_CODE = `{ rai_guard_second <- 2L; print('RAI_GUARD_SECOND_DONE') }`;

function findArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configPath = findArg('--mcp-config');
const stateDir = findArg('--test-state-dir');
if (!configPath || !stateDir)
  throw new Error('concurrent-run-guard provider requires --mcp-config and --test-state-dir');

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

// One run_r attempt, reported exactly as the native side answered it. Unlike
// the wait-for-approval helpers elsewhere in this suite, this never loops:
// the whole point is to capture the FIRST answer to a concurrent submission.
async function submitOnce(code) {
  const startedAt = Date.now();
  const attempt = await toolCall('run_r', { proposal: { language: 'R', target: 'console', code } });
  return {
    elapsed_ms: Date.now() - startedAt,
    status: attempt.result.status ?? null,
    run_id: attempt.result.run_id ?? null,
    message: attempt.result.message ?? null,
    error: attempt.result.error ?? null,
  };
}

async function submitAndQueue(code) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const attempt = await submitOnce(code);
    if (attempt.status === 'approval_required') {
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
      throw new Error(`concurrent-run-guard workflow requires tool "${required}", got: ${JSON.stringify(names)}`);
  }

  // --- Run 1 takes the slot and holds it for HOLD_SECONDS. -----------------
  const firstSubmit = await submitAndQueue(FIRST_CODE);
  if (!firstSubmit.run_id)
    throw new Error(`the first run_r did not queue: ${JSON.stringify(firstSubmit)}`);
  const firstRunId = firstSubmit.run_id;

  // Confirm run 1 really is still in flight before probing concurrency --
  // otherwise a fast machine could make this test assert nothing at all.
  const beforeConcurrent = await readRun(firstRunId);
  if (beforeConcurrent.status !== 'pending' && beforeConcurrent.status !== 'running')
    throw new Error(
      `run 1 settled before the concurrent submission (status=${beforeConcurrent.status}) -- ` +
      `it is not slow enough to prove the guard; increase HOLD_SECONDS`);

  // --- The probe: a DIFFERENT proposal while run 1 holds the slot. ---------
  const concurrentAttempt = await submitOnce(SECOND_CODE);

  // --- The control: run 1's OWN proposal, resubmitted while in flight. -----
  const duplicateAttempt = await submitOnce(FIRST_CODE);

  // --- Ground truth while run 1 is still running: run 2's binding must be
  // absent. This is the invariant that holds no matter how the guard reports
  // itself -- a queued-and-interleaved second run would show up here. -------
  const midRunStatus = await readRun(firstRunId);
  const environmentDuringHold = await environmentFound(['rai_guard_first', 'rai_guard_second']);

  const firstResult = await awaitSettled(firstRunId);
  if (firstResult.status !== 'ok')
    throw new Error(`run 1 did not succeed: ${JSON.stringify(firstResult)}`);
  if (!String(firstResult.stdout ?? '').includes('RAI_GUARD_FIRST_DONE'))
    throw new Error(`run 1 output is missing its sentinel: ${JSON.stringify(firstResult)}`);

  // --- After the slot frees, the rejected proposal must be submittable
  // again: the guard refuses a concurrent run, it does not poison it. -------
  const retryAttempt = await submitAndQueue(SECOND_CODE);
  if (!retryAttempt.run_id)
    throw new Error(`run 2 did not queue after the slot freed: ${JSON.stringify(retryAttempt)}`);
  const secondResult = await awaitSettled(retryAttempt.run_id);
  if (secondResult.status !== 'ok')
    throw new Error(`run 2 did not succeed once serialized: ${JSON.stringify(secondResult)}`);
  if (!String(secondResult.stdout ?? '').includes('RAI_GUARD_SECOND_DONE'))
    throw new Error(`run 2 output is missing its sentinel: ${JSON.stringify(secondResult)}`);

  const finalEnvironment = await environmentFound(['rai_guard_first', 'rai_guard_second']);

  writeFileSync(`${stateDir}/concurrent-guard-data.json`, JSON.stringify({
    hold_seconds: HOLD_SECONDS,
    first_run_id: firstRunId,
    first_submit: firstSubmit,
    status_before_concurrent: beforeConcurrent.status,
    concurrent_attempt: concurrentAttempt,
    duplicate_attempt: duplicateAttempt,
    status_after_probes: midRunStatus.status,
    environment_during_hold: environmentDuringHold,
    first_result: firstResult,
    retry_attempt: retryAttempt,
    second_result: secondResult,
    final_environment: finalEnvironment,
    poll_log: pollLog,
    transcript,
  }, null, 2));
  log('[fake-provider-concurrent-run-guard] data written');

  await sleep(30000);
}

main().catch((error) => {
  log(`[fake-provider-concurrent-run-guard] fatal: ${error.stack ?? error}`);
  writeFileSync(`${stateDir}/error.txt`, String(error?.stack ?? error));
  process.exitCode = 1;
}).finally(() => child.kill());
