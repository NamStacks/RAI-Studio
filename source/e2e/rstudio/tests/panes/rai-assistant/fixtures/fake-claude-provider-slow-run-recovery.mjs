#!/usr/bin/env node
// Deterministic, test-only MCP client proving the async run_r/get_run_result
// polling contract under a GENUINELY SLOW Console computation, not a fast
// fixed one. Every prior scripted fixture in this suite used near-instant R
// (arithmetic, a single plot() call), so none of them could catch a client
// that reads get_run_result once and wrongly treats an early "running"/
// "pending" status as final -- exactly the failure mode reported against the
// live Assistant for heavy user code. This fixture is the regression guard:
// it asserts the FIRST read is explicitly non-terminal, keeps polling
// without resubmitting code, and only then reads Console output, the new
// data-frame binding, and a freshly rendered plot.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

const SLEEP_SECONDS = 6;
// Sys.sleep has no approved effect contract. The hold uses neutral calls only.
export const RUN_CODE =
  `{ start <- as.numeric(Sys.time()); repeat { if (as.numeric(Sys.time()) - start >= ${SLEEP_SECONDS}) break }; ` +
  `rai_slow_df <- data.frame(x = 1:3, y = c(10L, 20L, 30L)); print(rai_slow_df) }`;
export const PLOT_CODE = "plot(rai_slow_df$x, rai_slow_df$y, main = 'RAI_SLOW_RUN_PLOT')";

function findArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configPath = findArg('--mcp-config');
const stateDir = findArg('--test-state-dir');
if (!configPath || !stateDir)
  throw new Error('slow-run-recovery provider requires --mcp-config and --test-state-dir');

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
  for (const required of ['run_r', 'get_run_result', 'get_environment_summary', 'get_plot_history', 'get_plot_image']) {
    if (!names.includes(required))
      throw new Error(`slow-run-recovery workflow requires tool "${required}", got: ${JSON.stringify(names)}`);
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

  // --- The regression assertion: read get_run_result ONCE, immediately,
  // before the sleep(SLEEP_SECONDS) can possibly have finished. A client
  // that treats this first read as final would report success/failure on
  // a run that has not actually executed the user's code yet.
  const firstRead = await toolCall('get_run_result', { run_id: runId });
  pollLog.push({ t_ms: Date.now() - submittedAt, status: firstRead.result.status });
  if (firstRead.result.status === 'ok' || firstRead.result.status === 'error')
    throw new Error(
      `get_run_result settled on the very first read (status=${firstRead.result.status}) -- ` +
      `this run is not actually slow enough to prove the polling contract; increase SLEEP_SECONDS`,
    );

  // --- Keep polling without resubmitting code until it genuinely settles.
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
  if (runResult.status !== 'ok')
    throw new Error(`slow Console run did not succeed: ${JSON.stringify(runResult)}`);
  if (elapsedMs < SLEEP_SECONDS * 1000)
    throw new Error(`run settled (${elapsedMs}ms) faster than its own ${SLEEP_SECONDS}s hold -- result cannot be trusted`);
  if (!String(runResult.stdout ?? '').includes('30'))
    throw new Error(`Console run did not produce the expected data.frame output: ${JSON.stringify(runResult)}`);

  // --- Environment check: the data frame created only after the sleep must
  // actually be visible now that the run has genuinely settled.
  const environmentDetail = await toolCall('get_environment_summary', { object_names: ['rai_slow_df'] });
  const dfEntry = environmentDetail.result.objects?.find((object) => object.name === 'rai_slow_df');
  if (!dfEntry?.found || !dfEntry.dims || dfEntry.dims[0] !== 3)
    throw new Error(`environment summary did not show rai_slow_df with 3 rows: ${JSON.stringify(environmentDetail.result)}`);

  // plot() has no approved effect contract. A separate proposal must be
  // refused and must not create a run.
  const plotAttempt = await toolCall('run_r', {
    proposal: { language: 'R', target: 'console', code: PLOT_CODE },
  });
  if (plotAttempt.result.run_id)
    throw new Error(`plot() was admitted: ${JSON.stringify(plotAttempt.result)}`);
  if (!String(plotAttempt.result.message ?? '').includes('no approved effect contract'))
    throw new Error(`plot() refusal was not the effect contract: ${JSON.stringify(plotAttempt.result)}`);

  writeFileSync(`${stateDir}/slow-run-data.json`, JSON.stringify({
    run_id: runId,
    console_run_result: runResult,
    elapsed_ms: elapsedMs,
    poll_log: pollLog,
    first_read_status: firstRead.result.status,
    environment_detail: environmentDetail.result,
    plot_attempt: plotAttempt.result,
    plot_image_present: false,
    transcript,
  }, null, 2));
  log('[fake-provider-slow-run-recovery] data written');

  await sleep(30000);
}

main().catch((error) => {
  log(`[fake-provider-slow-run-recovery] fatal: ${error.stack ?? error}`);
  writeFileSync(`${stateDir}/error.txt`, String(error?.stack ?? error));
  process.exitCode = 1;
}).finally(() => child.kill());


