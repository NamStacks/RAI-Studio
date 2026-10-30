#!/usr/bin/env node
// Deterministic test-only Assistant client. It sends one approval-gated raw R
// expression, waits for the native terminal error record, and only then reads
// the same run through get_debug_info with three explicitly named objects.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

const SAFE_OBJECT_R_CODE = "stop('RAI_S1_OBJECT_SUMMARY_ERROR')";
const OBJECT_NAMES = ['rai_s1_object', 'rai_s1_active', 'rai_s1_delayed'];
const ERROR_MARKER = 'RAI_S1_OBJECT_SUMMARY_ERROR';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const configPath = arg('--mcp-config');
const stateDir = arg('--test-state-dir');
if (!configPath || !stateDir)
  throw new Error('safe-object-summary provider requires --mcp-config and --test-state-dir');
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
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
lines.on('line', (line) => {
  try {
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  } catch {
    // Ignore non-JSON diagnostics; MCP itself is JSON lines.
  }
});

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function resultOf(response) {
  const text = response.result?.content?.[0]?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return { status: 'error', error: `invalid tool JSON: ${error.message}` };
    }
  }
  return { status: 'error', error: response.error?.message ?? 'MCP request failed' };
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const deadline = () => Date.now() + 120000;

async function callTool(transcript, tool, arguments_) {
  const response = await call('tools/call', { name: tool, arguments: arguments_ });
  const result = resultOf(response);
  transcript.push({ tool, arguments: arguments_, response, result });
  log(`[fake-provider-safe-object-summary] ${tool} request=${JSON.stringify(arguments_)} response=${JSON.stringify(response)}`);
  return { response, result };
}

async function main() {
  const transcript = [];
  const progression = [];
  const initialize = await call('initialize', { protocolVersion: '2024-11-05' });
  transcript.push({ tool: 'initialize', arguments: {}, response: initialize, result: resultOf(initialize) });

  const proposal = { language: 'R', target: 'console', code: SAFE_OBJECT_R_CODE };
  const until = deadline();
  let runId;
  while (Date.now() < until) {
    const { result } = await callTool(transcript, 'run_r', { proposal });
    if (result.status === 'approval_required') {
      progression.push({ phase: 'approval_required' });
      await sleep(200);
      continue;
    }
    if (!result.run_id)
      throw new Error(`run_r did not return a run_id: ${JSON.stringify(result)}`);
    runId = result.run_id;
    progression.push({ phase: 'run_registered', run_id: runId, status: result.status });
    break;
  }
  if (!runId)
    throw new Error('timed out awaiting the one native approval');

  let runResult;
  while (Date.now() < until) {
    const { result } = await callTool(transcript, 'get_run_result', { run_id: runId });
    if (result.status === 'pending') {
      progression.push({ phase: 'result_pending', run_id: runId });
      await sleep(200);
      continue;
    }
    runResult = result;
    break;
  }
  // The debug read is intentionally unreachable until native feedback has
  // positively identified this run and its terminal error capture.
  if (!runResult || runResult.status !== 'error' || runResult.run_id !== runId ||
      !JSON.stringify(runResult).includes(ERROR_MARKER)) {
    throw new Error(`native terminal error feedback was not confirmed: ${JSON.stringify(runResult)}`);
  }
  progression.push({ phase: 'native_error_confirmed', run_id: runId, status: runResult.status });

  const debugArguments = { run_id: runId, object_names: OBJECT_NAMES };
  const { response: debugResponse, result: debug } = await callTool(transcript, 'get_debug_info', debugArguments);
  progression.push({ phase: 'debug_info_read', run_id: runId, status: debug.status });

  writeFileSync(`${stateDir}/safe-object-summary-data.json`, JSON.stringify({
    proposal,
    object_names: OBJECT_NAMES,
    run_id: runId,
    run_result: runResult,
    debug,
    debug_response: debugResponse,
    transcript,
    progression,
  }, null, 2));
  log(`[fake-provider-safe-object-summary] native error then debug evidence written for ${runId}`);

  // Keep the Assistant transport stable while Playwright reads evidence.
  await sleep(90000);
}

main().catch((error) => {
  log(`[fake-provider-safe-object-summary] fatal: ${error.stack ?? error}`);
  process.exitCode = 1;
}).finally(() => child.kill());
