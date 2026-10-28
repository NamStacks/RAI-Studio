#!/usr/bin/env node
// Regression guard for an R session restart landing while a Console run is
// STILL IN FLIGHT. fake-claude-provider-session-recycle.mjs restarts after a
// chunk completed and its result was already read, so the run it asks about
// is a settled record with a stored result. That is the tidy case. This is
// the race: the run is registered, its code is executing (a Sys.time hold is
// keeping the Console open), nothing has been polled to completion, and the
// session is pulled out from under it.
//
// Two hazards live here that the settled case cannot reach:
//
//   1. The in-flight run_id. Its code never finished and it has no result at
//      all -- not a stale one, none. get_run_result must say so rather than
//      hang, time out, or invent a terminal status.
//   2. The capture slot. The killed run held it (RaiCaptureArmed/Capturing).
//      If a restart could leave the slot occupied, every later run_r in the
//      fresh session would answer "busy" forever and the Assistant's Console
//      path would be permanently wedged -- a far worse failure than a lost
//      result, and one only an in-flight restart can produce.
//
// OBSERVED NATIVE BEHAVIOR (recorded here rather than assumed):
//
//   * get_run_result on the in-flight run_id answers "session_restarted"
//     promptly. The bridge (rai-native-mcp.js) remembers run_id -> session_id
//     at queue time and compares against the live session id, so the answer
//     comes from the identity mismatch and never from the dead run's record.
//   * The capture slot is NOT wedged: the fresh session is a new process, so
//     the process-global slot starts Idle and new runs queue and complete
//     normally.
//   * The interrupted binding does not exist: the sleep never finished, so
//     the assignment after it never ran, and the new session has no trace.
//
// Proving the race actually happened is the delicate part, because a restart
// that merely WAITED for R to go idle would look identical afterwards (a
// restart clears .GlobalEnv either way, so an absent binding proves nothing
// on its own). The discriminator is timing: the run is confirmed non-terminal
// immediately before the handoff, and the test reports how long after that
// checkpoint the restart completed. Sys.sleep(HOLD_SECONDS) began before the
// checkpoint, so a restart completing well inside that window can only have
// landed while the code was still executing.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

// Long enough that the restart is guaranteed to land mid-run: the test
// triggers it within a second or two of the checkpoint, and the fixture
// re-confirms the run is still non-terminal immediately before handing off.
const HOLD_SECONDS = 90;
// The binding is assigned AFTER the sleep, so it can only exist if the run
// ran to completion -- which a mid-run restart must prevent.
// Sys.sleep has no approved effect contract, so the hold is a neutral
// repeat over Sys.time. The Console stays busy for HOLD_SECONDS either way.
export const INFLIGHT_CODE =
  `{ start <- Sys.time(); repeat { if (as.numeric(Sys.time() - start, units = "secs") >= ${HOLD_SECONDS}) break }; rai_inflight_marker <- 1L; print('RAI_INFLIGHT_DONE') }`;
export const RECOVERY_CODE =
  `{ rai_inflight_recovery <- 7L; print('RAI_INFLIGHT_RECOVERY_DONE') }`;
// Ground truth from the live Console after the restart.
export const PROBE_CODE =
  "{ marker_present <- identical(try(force(rai_inflight_marker), silent = TRUE), 1L); " +
  "recovery_present <- identical(try(force(rai_inflight_recovery), silent = TRUE), 7L); " +
  "cat('RAI_INFLIGHT_PROBE', marker_present, recovery_present, '\\n') }";

function findArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configPath = findArg('--mcp-config');
const stateDir = findArg('--test-state-dir');
if (!configPath || !stateDir)
  throw new Error('restart-during-inflight-run provider requires --mcp-config and --test-state-dir');

mkdirSync(stateDir, { recursive: true });
writeFileSync(`${stateDir}/provider.pid`, String(process.pid));
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

async function submitOnce(code) {
  const attempt = await toolCall('run_r', { proposal: { language: 'R', target: 'console', code } });
  return {
    status: attempt.result.status ?? null,
    run_id: attempt.result.run_id ?? null,
    message: attempt.result.message ?? null,
  };
}

async function submitAndQueue(code, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const attempt = await submitOnce(code);
    if (attempt.status === 'approval_required' || attempt.status === 'busy') {
      await sleep(250);
      continue;
    }
    if (!attempt.run_id)
      throw new Error(`run_r did not return a run_id: ${JSON.stringify(attempt)}`);
    return attempt;
  }
  throw new Error(`timed out waiting for a queue decision on: ${code}`);
}

async function readRun(runId) {
  const readResult = await toolCall('get_run_result', { run_id: runId });
  return readResult.result;
}

async function awaitSettled(runId, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await readRun(runId);
    if (result.status === 'pending' || result.status === 'running') {
      await sleep(300);
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

async function waitForFile(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(`${stateDir}/${name}`))
      return;
    await sleep(200);
  }
  throw new Error(`restart-during-inflight-run provider timed out waiting for ${name}`);
}

// A restart tears down the session's HTTP endpoint for a moment, so a read
// landing in that window fails at the transport level rather than answering.
// This retries ONLY that -- a thrown request error or an explicit
// transport-level rejection -- and counts the attempts, so the retry can never
// quietly launder a real answer into a nicer one: whatever the first genuine
// answer is, it is the one recorded and asserted.
async function untilSessionAnswers(read, label, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastError;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const value = await read();
      return { value, attempts };
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw new Error(`the restarted session never answered ${label}: ${lastError?.message ?? lastError}`);
}

function isTransportFailure(result) {
  return result.status === 'error' &&
    /rejected|did not respond|ECONNREFUSED|socket hang up|fetch failed/i.test(String(result.error ?? result.message ?? ''));
}

async function main() {
  transcript.push({ method: 'initialize', response: await call('initialize', { protocolVersion: '2024-11-05' }) });
  const listed = await call('tools/list', {});
  const names = listed.result?.tools?.map((entry) => entry.name) ?? [];
  for (const required of ['run_r', 'get_run_result', 'get_environment_summary']) {
    if (!names.includes(required))
      throw new Error(`restart-during-inflight-run workflow requires tool "${required}", got: ${JSON.stringify(names)}`);
  }

  // --- Start the long run and leave it holding the Console. ---------------
  const inflight = await submitAndQueue(INFLIGHT_CODE);
  stepLog.push({ step: 'inflight-submit', status: inflight.status });

  // --- Prove it is genuinely in flight before the restart: a settled run
  // here would make this fixture the session-recycle test over again. ------
  const statusBeforeRestart = (await readRun(inflight.run_id)).status;
  if (statusBeforeRestart !== 'pending' && statusBeforeRestart !== 'running')
    throw new Error(
      `the run settled before the restart could be requested (status=${statusBeforeRestart}) -- ` +
      `there is no race to test; increase HOLD_SECONDS`);
  stepLog.push({ step: 'status-before-restart', status: statusBeforeRestart });

  // --- Hand off to the test, which restarts R underneath the running code.
  // The run_id is published so the test can report it in its evidence. -----
  const checkpointAt = Date.now();
  writeFileSync(`${stateDir}/inflight-checkpoint`, JSON.stringify({
    run_id: inflight.run_id,
    status_before_restart: statusBeforeRestart,
    hold_seconds: HOLD_SECONDS,
    checkpoint_at: checkpointAt,
  }));
  log('[fake-provider-restart-during-inflight-run] checkpoint written; awaiting the restart');
  await waitForFile('post-restart', 240000);
  // Written by the test once the restart has completed; it carries the timing
  // that proves the restart landed inside the run rather than after it.
  const restartReport = JSON.parse(readFileSync(`${stateDir}/post-restart`, 'utf8'));
  const restartCompletedAfterCheckpointMs = restartReport.restart_completed_at - checkpointAt;

  // --- Hazard 1: read the in-flight run_id after the restart. -------------
  const staleReadStartedAt = Date.now();
  const staleRead = await untilSessionAnswers(async () => {
    const result = await readRun(inflight.run_id);
    if (isTransportFailure(result))
      throw new Error(String(result.error ?? result.message));
    // A run that is somehow still reported as live after the session that
    // owned it was destroyed is itself the bug; do not poll it away.
    return result;
  }, 'the in-flight run read');
  const staleReadElapsedMs = Date.now() - staleReadStartedAt;
  stepLog.push({ step: 'inflight-run-read', status: staleRead.value.status, attempts: staleRead.attempts });

  // --- Hazard 2: the capture slot must be free, so a brand-new run in the
  // fresh session queues and completes normally. ---------------------------
  const recovery = await untilSessionAnswers(() => submitAndQueue(RECOVERY_CODE), 'the recovery submission');
  stepLog.push({ step: 'recovery-submit', status: recovery.value.status, attempts: recovery.attempts });
  if (recovery.value.run_id === inflight.run_id)
    throw new Error('the recovery run reused the dead run_id');
  const recoveryResult = await awaitSettled(recovery.value.run_id);
  stepLog.push({ step: 'recovery-result', status: recoveryResult.status });
  if (recoveryResult.status !== 'ok')
    throw new Error(`the post-restart recovery run failed: ${JSON.stringify(recoveryResult)}`);
  if (!String(recoveryResult.stdout ?? '').includes('RAI_INFLIGHT_RECOVERY_DONE'))
    throw new Error(`the recovery run output is missing its sentinel: ${JSON.stringify(recoveryResult)}`);

  // The identical-proposal resubmission is deliberately NOT probed here: it
  // would queue another HOLD_SECONDS sleep, and rstudioPage is worker-scoped,
  // so that run would still be holding the Console when the next spec in the
  // suite starts. Test 1 (concurrent-run-distinct-guard) already covers that a
  // settled proposal registers a fresh run rather than replaying an old one.

  // --- Ground truth from the live Console. --------------------------------
  const environmentAfter = await environmentFound(['rai_inflight_marker', 'rai_inflight_recovery']);
  const probe = await submitAndQueue(PROBE_CODE);
  const probeResult = await awaitSettled(probe.run_id);
  stepLog.push({ step: 'console-probe', status: probeResult.status });
  if (probeResult.status !== 'ok')
    throw new Error(`the post-restart Console probe failed: ${JSON.stringify(probeResult)}`);
  const probeMatch = String(probeResult.stdout ?? '')
    .match(/RAI_INFLIGHT_PROBE\s+(TRUE|FALSE)\s+(TRUE|FALSE)/);
  if (!probeMatch)
    throw new Error(`could not read the Console probe output: ${JSON.stringify(probeResult)}`);
  const consoleTruth = {
    rai_inflight_marker: probeMatch[1] === 'TRUE',
    rai_inflight_recovery: probeMatch[2] === 'TRUE',
  };
  const environmentAgreesWithConsole =
    environmentAfter.rai_inflight_marker === consoleTruth.rai_inflight_marker &&
    environmentAfter.rai_inflight_recovery === consoleTruth.rai_inflight_recovery;
  if (!environmentAgreesWithConsole)
    throw new Error(
      `get_environment_summary disagreed with the live Console after the restart: ` +
      `${JSON.stringify(environmentAfter)} vs ${JSON.stringify(consoleTruth)}`);

  writeFileSync(`${stateDir}/restart-inflight-data.json`, JSON.stringify({
    hold_seconds: HOLD_SECONDS,
    inflight_run_id: inflight.run_id,
    status_before_restart: statusBeforeRestart,
    step_log: stepLog,
    inflight_run_read: staleRead.value,
    inflight_run_read_attempts: staleRead.attempts,
    inflight_run_read_elapsed_ms: staleReadElapsedMs,
    recovery_attempt: recovery.value,
    recovery_attempts: recovery.attempts,
    recovery_result: recoveryResult,
    checkpoint_at: checkpointAt,
    restart_completed_after_checkpoint_ms: restartCompletedAfterCheckpointMs,
    environment_after: environmentAfter,
    console_truth: consoleTruth,
    console_probe_stdout: probeResult.stdout ?? null,
    environment_agrees_with_console: environmentAgreesWithConsole,
    transcript,
  }, null, 2));
  log('[fake-provider-restart-during-inflight-run] data written');

  await sleep(30000);
}

main().catch((error) => {
  log(`[fake-provider-restart-during-inflight-run] fatal: ${error.stack ?? error}`);
  writeFileSync(`${stateDir}/error.txt`, String(error?.stack ?? error));
  process.exitCode = 1;
}).finally(() => child.kill());



