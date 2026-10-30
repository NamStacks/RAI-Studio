#!/usr/bin/env node
// Test-only stand-in for the `claude` CLI, used by
// rai-console-decline-scripted.test.ts to prove the declined-approval path:
// zero Console input when a human declines. Mirrors fake-claude-provider.mjs
// (same real MCP protocol against the real native /run endpoint) but leaves
// its single proposal pending until the test declines it.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

function log(line) {
  process.stdout.write(`${line}\n`);
}

function findArg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const configPath = findArg('--mcp-config');
const stateDir = findArg('--test-state-dir');
if (stateDir) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(`${stateDir}/provider.pid`, String(process.pid));
}
if (!configPath) {
  log('[fake-provider-decline] no --mcp-config argv; nothing to do');
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const server = sessionMcpServer(config);
if (!server) {
  log('[fake-provider-decline] no mcpServers.rai entry in MCP config');
  process.exit(1);
}

log('[fake-provider-decline] Welcome to the fake Claude Code stand-in (test harness only)');
log(`[fake-provider-decline] WORKSPACE: ${process.cwd()}`);
log(`[fake-provider-decline] launching MCP server: ${server.command} ${(server.args ?? []).join(' ')}`);

const child = spawn(server.command, server.args ?? [], {
  env: { ...process.env, ...(server.env ?? {}) },
  stdio: ['pipe', 'pipe', 'inherit'],
});
if (stateDir) writeFileSync(`${stateDir}/mcp.pid`, String(child.pid));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
    process.exit(0);
  });
}

const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
let nextId = 1;

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const resolve = pending.get(msg.id);
  if (resolve) {
    pending.delete(msg.id);
    resolve(msg);
  }
});

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function toolResult(msg) {
  const text = msg.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : msg.error;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await call('initialize', { protocolVersion: '2024-11-05' });
  // Keep the terminal visible long enough for the test to prove the provider
  // inherited the active RStudio project directory before it submits the
  // run requiring native approval.
  await sleep(1500);

  const proposal = {
    language: 'R',
    target: 'console',
    code: 'Sys.sleep(30)',
  };
  log(`[fake-provider-decline] run_r -> ${JSON.stringify(proposal)}`);

  // Submit exactly once and then park. A retry loop here would create a
  // *second* pending approval request once the first is resolved (declined),
  // popping a second approval card mid-test for no benefit -- proving zero
  // Console input only needs the single declined proposal to sit resolved
  // while the test watches the Console. Hold the pty open for the rest of
  // the test's timeout budget so the terminal doesn't exit/reconnect out
  // from under it; the harness kills the process tree on teardown regardless.
  const response = await call('tools/call', { name: 'run_r', arguments: { proposal } });
  const result = toolResult(response);
  if (stateDir)
    writeFileSync(`${stateDir}/decline-result.json`, JSON.stringify(result));
  if (result.run_id || result.status === 'queued' || result.status === 'ok')
    log(`[fake-provider-decline] UNEXPECTED admission: ${JSON.stringify(result)}`);
  else
    log(`[fake-provider-decline] run_r status: ${JSON.stringify(result)}`);
  await sleep(70000);
}

main().finally(() => child.kill());
