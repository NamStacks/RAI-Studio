#!/usr/bin/env node
// Regression guard for an R session recycle landing in the MIDDLE of a
// chunk-by-chunk audit. rai-restart-recovery-scripted.test.ts already proves
// the Assistant stays alive and approval-gated across Restart R + Run All
// Chunks, but it restarts BEFORE any audit work exists, so nothing it asserts
// could catch the failure that actually matters here: an audit that keeps
// reasoning from pre-restart state after the session under it was replaced.
//
// Two distinct stale-state hazards, both covered:
//
//   1. A run_id from the old session. Its stored result is gone with the
//      session, so re-reading it must not hand back the old text as if it
//      still described anything live.
//   2. A .GlobalEnv binding created by a Console run in the old session.
//      After the recycle it must be reported as the NEW session actually
//      finds it -- never from a cache, and never carried over.
//
// Hazard 2 is checked against ground truth rather than against an assumption:
// the same question is asked twice, once through get_environment_summary and
// once by running exists() in the live Console, and the two must agree. That
// holds whatever the restart semantics turn out to be, which is the point --
// a cached answer would drift from the Console, a live one cannot.
//
// The chunk marker is the control: it is created only by the .Rmd chunk that
// Restart R + Run All Chunks re-executes, so its presence proves the recycle
// really happened and the new session really ran the document.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

// Created by a Console run only -- it appears in no chunk, so nothing can
// recreate it after a restart.
export const CONSOLE_CODE = "{ rai_recycle_console <- 99L; print('RAI_RECYCLE_CONSOLE_SET') }";
// Ground truth read from the live Console after the recycle.
// exists() has no approved effect contract, and an anonymous tryCatch handler
// is refused as an uninspectable higher-order argument. try() returns the
// value when the binding survived and a try-error when the recycle cleared it.
export const PROBE_CODE =
  "{ console_present <- identical(try(force(rai_recycle_console), silent = TRUE), 99L); " +
  "chunk_present <- identical(try(force(rai_recycle_chunk), silent = TRUE), 'ran'); " +
  "cat('RAI_RECYCLE_PROBE', console_present, chunk_present, '\\n') }";

function findArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configPath = findArg('--mcp-config');
const stateDir = findArg('--test-state-dir');
if (!configPath || !stateDir)
  throw new Error('session-recycle provider requires --mcp-config and --test-state-dir');

mkdirSync(stateDir, { recursive: true });
writeFileSync(`${stateDir}/provider.pid`, String(process.pid));
// The bridge owns the provider process across an R restart. If that ever
// changes, this counter makes the respawn visible instead of silent.
appendFileSync(`${stateDir}/provider-starts.log`, `${Date.now()} ${process.pid}\n`);

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
const stepLog = [];

async function toolCall(name, args) {
  const response = await call('tools/call', { name, arguments: args });
  const result = textToolResult(response);
  transcript.push({ tool: name, arguments: args, response, result });
  return { response, result };
}

async function runAndAwait(code, timeoutMs = 90000) {
  const proposal = { language: 'R', target: 'console', code };
  const deadline = Date.now() + timeoutMs;
  let runId;
  while (Date.now() < deadline) {
    const run = await toolCall('run_r', { proposal });
    if (run.result.status === 'approval_required' || run.result.status === 'busy') {
      await sleep(250);
      continue;
    }
    if (!run.result.run_id)
      throw new Error(`run_r did not return a run_id: ${JSON.stringify(run.result)}`);
    runId = run.result.run_id;
    break;
  }
  if (!runId)
    throw new Error(`timed out waiting for approval of proposal: ${code}`);

  while (Date.now() < deadline) {
    const readResult = await toolCall('get_run_result', { run_id: runId });
    if (readResult.result.status === 'pending' || readResult.result.status === 'running') {
      await sleep(250);
      continue;
    }
    return { run_id: runId, result: readResult.result };
  }
  throw new Error(`timed out waiting for get_run_result(${runId})`);
}

async function environmentFound(names) {
  const summary = await toolCall('get_environment_summary', { object_names: names });
  const objects = summary.result.objects ?? [];
  return Object.fromEntries(names.map((name) =>
    [name, Boolean(objects.find((object) => object.name === name)?.found)]));
}

async function waitForFile(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(`${stateDir}/${name}`))
      return;
    await sleep(200);
  }
  throw new Error(`session-recycle provider timed out waiting for ${name}`);
}

// A recycle tears down the session's HTTP endpoint for a moment; a read that
// lands in that window fails transport-level rather than answering. Retry
// until the new session is actually answering before reading any state.
async function untilSessionAnswers(read, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw new Error(`the recycled session never answered: ${lastError?.message ?? lastError}`);
}

async function main() {
  transcript.push({ method: 'initialize', response: await call('initialize', { protocolVersion: '2024-11-05' }) });
  const listed = await call('tools/list', {});
  const names = listed.result?.tools?.map((entry) => entry.name) ?? [];
  for (const required of ['run_r', 'get_run_result', 'get_environment_summary']) {
    if (!names.includes(required))
      throw new Error(`session-recycle workflow requires tool "${required}", got: ${JSON.stringify(names)}`);
  }

  // --- Audit step 1, BEFORE the recycle: a Console run creates a binding
  // that exists nowhere in the document. ------------------------------------
  const preRun = await runAndAwait(CONSOLE_CODE);
  stepLog.push({ step: 'pre-restart-run', status: preRun.result.status });
  if (preRun.result.status !== 'ok')
    throw new Error(`the pre-restart audit chunk failed: ${JSON.stringify(preRun.result)}`);
  const environmentBefore = await environmentFound(['rai_recycle_console', 'rai_recycle_chunk']);
  if (!environmentBefore.rai_recycle_console)
    throw new Error(`the pre-restart chunk did not bind rai_recycle_console: ${JSON.stringify(environmentBefore)}`);

  // --- Hand off to the test, which recycles the session underneath us. -----
  writeFileSync(`${stateDir}/audit-checkpoint`, 'ready');
  log('[fake-provider-session-recycle] checkpoint written; awaiting the recycle');
  await waitForFile('post-restart', 180000);

  // --- Hazard 1: the old session's run_id must not replay its old result. --
  const staleRead = await untilSessionAnswers(async () => {
    const response = await toolCall('get_run_result', { run_id: preRun.run_id });
    if (response.result.status === 'error' && /rejected|did not respond/i.test(String(response.result.error ?? '')))
      throw new Error(String(response.result.error));
    return response.result;
  });
  stepLog.push({ step: 'stale-run-read', status: staleRead.status });

  // --- Hazard 2: environment state, read through MCP after the recycle. ----
  const environmentAfter = await untilSessionAnswers(() =>
    environmentFound(['rai_recycle_console', 'rai_recycle_chunk']));
  stepLog.push({ step: 'environment-after', ...environmentAfter });

  // --- Ground truth for hazard 2, straight from the live Console. ----------
  const probeRun = await untilSessionAnswers(() => runAndAwait(PROBE_CODE));
  stepLog.push({ step: 'console-probe', status: probeRun.result.status });
  if (probeRun.result.status !== 'ok')
    throw new Error(`the post-restart Console probe failed: ${JSON.stringify(probeRun.result)}`);
  const probeMatch = String(probeRun.result.stdout ?? '')
    .match(/RAI_RECYCLE_PROBE\s+(TRUE|FALSE)\s+(TRUE|FALSE)/);
  if (!probeMatch)
    throw new Error(`could not read the Console probe output: ${JSON.stringify(probeRun.result)}`);
  const consoleTruth = {
    rai_recycle_console: probeMatch[1] === 'TRUE',
    rai_recycle_chunk: probeMatch[2] === 'TRUE',
  };

  // --- The assertion that holds regardless of restart semantics: the MCP
  // view and the Console's own view of .GlobalEnv must agree. A cached or
  // carried-over answer would diverge here; a live one cannot. --------------
  const environmentAgreesWithConsole =
    environmentAfter.rai_recycle_console === consoleTruth.rai_recycle_console &&
    environmentAfter.rai_recycle_chunk === consoleTruth.rai_recycle_chunk;
  if (!environmentAgreesWithConsole)
    throw new Error(
      `get_environment_summary disagreed with the live Console after the recycle: ` +
      `${JSON.stringify(environmentAfter)} vs ${JSON.stringify(consoleTruth)}`);

  writeFileSync(`${stateDir}/session-recycle-data.json`, JSON.stringify({
    step_log: stepLog,
    pre_run_id: preRun.run_id,
    pre_run_result: preRun.result,
    environment_before: environmentBefore,
    stale_run_read: staleRead,
    environment_after: environmentAfter,
    console_truth: consoleTruth,
    console_probe_stdout: probeRun.result.stdout ?? null,
    environment_agrees_with_console: environmentAgreesWithConsole,
    transcript,
  }, null, 2));
  log('[fake-provider-session-recycle] data written');

  await sleep(30000);
}

main().catch((error) => {
  log(`[fake-provider-session-recycle] fatal: ${error.stack ?? error}`);
  writeFileSync(`${stateDir}/error.txt`, String(error?.stack ?? error));
  process.exitCode = 1;
}).finally(() => child.kill());

