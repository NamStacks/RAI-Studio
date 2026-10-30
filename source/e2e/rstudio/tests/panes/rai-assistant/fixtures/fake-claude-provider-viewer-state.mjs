#!/usr/bin/env node
// Deterministic, test-only Stage 3 MCP client for get_viewer_state. It makes
// exactly one tool call -- get_viewer_state with no arguments -- and nothing
// else: no run_r proposal, no approval, no other tool. Any Viewer content
// that exists at the time of the call was established entirely by the
// Playwright test's own non-MCP harness before this provider ever launches,
// via the same executeInConsole() helper other pane specs use directly. This
// provider only reads and records the raw MCP response; it never asks the
// native endpoint to create, clear, or otherwise mutate Viewer state.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

function findArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configPath = findArg('--mcp-config');
const stateDir = findArg('--test-state-dir');
if (!configPath || !stateDir)
  throw new Error('viewer-state provider requires --mcp-config and --test-state-dir');

mkdirSync(stateDir, { recursive: true });
writeFileSync(`${stateDir}/provider.pid`, String(process.pid));
const scenarioPath = `${stateDir}/scenario.json`;
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
if (!['inactive', 'active'].includes(scenario.mode))
  throw new Error('viewer-state scenario mode must be inactive or active');

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

function textToolResult(message) {
  const text = message.result?.content?.[0]?.text;
  if (text) return JSON.parse(text);
  return { status: 'error', error: message.error?.message ?? 'MCP request failed' };
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main() {
  const transcript = [];
  transcript.push({ method: 'initialize', response: await call('initialize', { protocolVersion: '2024-11-05' }) });

  // The one and only tool call this provider ever makes. No run_r, no
  // approval flow, no arguments -- get_viewer_state takes none.
  const viewerResponse = await call('tools/call', { name: 'get_viewer_state', arguments: {} });
  const viewerResult = textToolResult(viewerResponse);
  transcript.push({ tool: 'get_viewer_state', arguments: {}, response: viewerResponse, result: viewerResult });

  writeFileSync(`${stateDir}/viewer-state-data.json`, JSON.stringify({
    mode: scenario.mode,
    viewer_response: viewerResponse,
    viewer_result: viewerResult,
    transcript,
  }, null, 2));
  log(`[fake-provider-viewer-state] ${scenario.mode} data written`);

  // Keep the provider/Assistant iframe stable until fixture teardown.
  await sleep(90000);
}

main().catch((error) => {
  log(`[fake-provider-viewer-state] fatal: ${error.stack ?? error}`);
  process.exitCode = 1;
}).finally(() => child.kill());
