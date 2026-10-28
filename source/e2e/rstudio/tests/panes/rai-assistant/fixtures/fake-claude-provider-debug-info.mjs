#!/usr/bin/env node
// Deterministic, test-only Stage 1 debugging client. It drives the real MCP
// bridge through exactly one approval-gated run_r proposal, reads its terminal
// get_run_result, then reads get_debug_info for that same opaque run id. The
// complete raw protocol sequence is persisted so Playwright can prove the
// read-only debugging call did not submit a second Console input.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

const DEBUG_R_CODE = "{\n  warning('RAI_DEBUG_WARNING_ONE', call. = FALSE)\n  warning('RAI_DEBUG_WARNING_TWO', call. = FALSE)\n  stop('RAI_DEBUG_ERROR')\n}";

function findArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configPath = findArg('--mcp-config');
const stateDir = findArg('--test-state-dir');
if (!configPath || !stateDir)
  throw new Error('debug-info provider requires --mcp-config and --test-state-dir');

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
const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on('line', (line) => {
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

function toolResult(message) {
  const text = message.result?.content?.[0]?.text;
  if (text) return JSON.parse(text);
  return { status: 'error', error: message.error?.message ?? 'MCP request failed' };
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const deadline = () => Date.now() + 120000;

async function main() {
  const transcript = [];
  transcript.push({ method: 'initialize', response: await call('initialize', { protocolVersion: '2024-11-05' }) });

  const proposal = { language: 'R', target: 'console', code: DEBUG_R_CODE };
  let runId;
  const until = deadline();
  while (Date.now() < until) {
    const response = await call('tools/call', { name: 'run_r', arguments: { proposal } });
    const result = toolResult(response);
    transcript.push({ tool: 'run_r', arguments: { proposal }, response, result });
    if (result.status === 'approval_required') {
      await sleep(250);
      continue;
    }
    if (!result.run_id)
      throw new Error(`run_r did not return a run_id: ${JSON.stringify(result)}`);
    runId = result.run_id;
    break;
  }
  if (!runId)
    throw new Error('timed out waiting for the one native approval');

  let runResult;
  while (Date.now() < until) {
    const response = await call('tools/call', { name: 'get_run_result', arguments: { run_id: runId } });
    const result = toolResult(response);
    transcript.push({ tool: 'get_run_result', arguments: { run_id: runId }, response, result });
    if (result.status === 'pending') {
      await sleep(250);
      continue;
    }
    runResult = result;
    break;
  }
  if (!runResult)
    throw new Error(`timed out waiting for get_run_result(${runId})`);

  const debugResponse = await call('tools/call', { name: 'get_debug_info', arguments: { run_id: runId } });
  const debug = toolResult(debugResponse);
  transcript.push({ tool: 'get_debug_info', arguments: { run_id: runId }, response: debugResponse, result: debug });

  writeFileSync(`${stateDir}/debug-data.json`, JSON.stringify({
    proposal,
    run_id: runId,
    run_result: runResult,
    debug,
    transcript,
  }, null, 2));
  log(`[fake-provider-debug-info] debug data written for ${runId}`);

  // Keep the provider/Assistant iframe stable while Playwright reads its
  // state file. Fixture teardown terminates this process and its MCP child.
  await sleep(90000);
}

main().catch((error) => {
  log(`[fake-provider-debug-info] fatal: ${error.stack ?? error}`);
  process.exitCode = 1;
}).finally(() => child.kill());
