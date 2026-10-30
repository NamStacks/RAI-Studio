#!/usr/bin/env node
// Regression guard for the async run_r/get_run_result polling contract on
// the ERROR path of a genuinely slow computation. The companion
// slow-run-recovery fixture only proves polling settles correctly on
// success; this proves the same non-terminal-then-settle sequence when the
// slow chunk actually errors partway through, and that the Assistant/client
// distinguishes "still running" from "failed" rather than misreading an
// early non-terminal read as either outcome.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

const SLEEP_SECONDS = 5;
// Sys.sleep has no approved effect contract. The hold uses neutral calls only.
export const RUN_CODE =
  `{ start <- as.numeric(Sys.time()); repeat { if (as.numeric(Sys.time()) - start >= ${SLEEP_SECONDS}) break }; stop("rai_slow_error_boom") }`;

function findArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configPath = findArg('--mcp-config');
const stateDir = findArg('--test-state-dir');
if (!configPath || !stateDir)
  throw new Error('slow-run-error provider requires --mcp-config and --test-state-dir');

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

async function main() {
  transcript.push({ method: 'initialize', response: await call('initialize', { protocolVersion: '2024-11-05' }) });
  const listed = await call('tools/list', {});
  const names = listed.result?.tools?.map((entry) => entry.name) ?? [];
  for (const required of ['run_r', 'get_run_result']) {
    if (!names.includes(required))
      throw new Error(`slow-run-error workflow requires tool "${required}", got: ${JSON.stringify(names)}`);
  }

  const submittedAt = Date.now();
  const proposal = { language: 'R', target: 'console', code: RUN_CODE };
  const runDeadline = Date.now() + 90000;
  let runId;
  while (Date.now() < runDeadline) {
    const run = await toolCall('run_r', { proposal });
    if (run.result.status === 'approval_required') {
      await sleep(250);
      continue;
    }
    if (!run.result.run_id)
      throw new Error(`run_r did not return a run_id: ${JSON.stringify(run.result)}`);
    runId = run.result.run_id;
    break;
  }
  if (!runId)
    throw new Error('timed out waiting for the Console run proposal to be approved');

  // --- Regression assertion: the first read must be non-terminal, exactly
  // like the success-path fixture, proving polling is required regardless
  // of whether the run will end up succeeding or failing. ------------------
  const firstRead = await toolCall('get_run_result', { run_id: runId });
  pollLog.push({ t_ms: Date.now() - submittedAt, status: firstRead.result.status });
  if (firstRead.result.status === 'ok' || firstRead.result.status === 'error')
    throw new Error(
      `get_run_result settled on the very first read (status=${firstRead.result.status}) -- ` +
      `this run is not actually slow enough to prove the polling contract; increase SLEEP_SECONDS`,
    );

  // --- Keep polling without resubmitting code until it genuinely settles,
  // to whatever terminal status it actually reaches. -----------------------
  let runResult;
  while (Date.now() < runDeadline) {
    const readResult = await toolCall('get_run_result', { run_id: runId });
    pollLog.push({ t_ms: Date.now() - submittedAt, status: readResult.result.status });
    if (readResult.result.status === 'pending' || readResult.result.status === 'running') {
      await sleep(500);
      continue;
    }
    runResult = readResult.result;
    break;
  }
  if (!runResult)
    throw new Error(`timed out waiting for get_run_result(${runId}) to settle`);
  const elapsedMs = Date.now() - submittedAt;

  // --- The regression's whole point: polling must correctly distinguish
  // "still running" from "failed" -- a client that misread the first
  // non-terminal read as success (or as failure) would already have thrown
  // above or reported the wrong outcome to the user. This asserts the
  // FINAL settled status is the correct terminal error, not a guess made
  // from an earlier non-terminal snapshot. ----------------------------------
  if (runResult.status !== 'error')
    throw new Error(`slow Console run did not settle to an error as expected: ${JSON.stringify(runResult)}`);
  if (elapsedMs < SLEEP_SECONDS * 1000)
    throw new Error(`run settled (${elapsedMs}ms) faster than its own ${SLEEP_SECONDS}s hold -- result cannot be trusted`);
  if (!String(runResult.stderr ?? '').includes('rai_slow_error_boom'))
    throw new Error(`Console run error did not surface the expected stop() message: ${JSON.stringify(runResult)}`);

  writeFileSync(`${stateDir}/slow-error-data.json`, JSON.stringify({
    run_id: runId,
    console_run_result: runResult,
    elapsed_ms: elapsedMs,
    poll_log: pollLog,
    first_read_status: firstRead.result.status,
    transcript,
  }, null, 2));
  log('[fake-provider-slow-run-error] data written');

  await sleep(30000);
}

main().catch((error) => {
  log(`[fake-provider-slow-run-error] fatal: ${error.stack ?? error}`);
  writeFileSync(`${stateDir}/error.txt`, String(error?.stack ?? error));
  process.exitCode = 1;
}).finally(() => child.kill());


