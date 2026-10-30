#!/usr/bin/env node
// Real packaged-app monitor proof: one approval-gated R run, one read-only
// monitor_console_run call while it is active, then one final result read.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

// Sys.sleep has no approved effect contract. The hold uses neutral calls only.
const RUN_CODE = "{ cat('RAI_MONITOR_START\\n'); start <- as.numeric(Sys.time()); repeat { if (as.numeric(Sys.time()) - start >= 20) break }; cat('RAI_MONITOR_DONE\\n') }";
const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const configPath = arg('--mcp-config');
const stateDir = arg('--test-state-dir');
if (!configPath || !stateDir) throw new Error('console-monitor fixture requires --mcp-config and --test-state-dir');
mkdirSync(stateDir, { recursive: true });
writeFileSync(`${stateDir}/provider.pid`, String(process.pid));
const log = (line) => { process.stdout.write(`${line}\n`); appendFileSync(`${stateDir}/provider.log`, `${line}\n`); };
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const server = sessionMcpServer(config);
if (!server) throw new Error('MCP config has no rai server');
const child = spawn(server.command, server.args ?? [], { env: { ...process.env, ...(server.env ?? {}) }, stdio: ['pipe', 'pipe', 'inherit'] });
writeFileSync(`${stateDir}/mcp.pid`, String(child.pid));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); process.exit(0); });
const pending = new Map();
let nextId = 1;
readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
  try { const message = JSON.parse(line); const resolve = pending.get(message.id); if (resolve) { pending.delete(message.id); resolve(message); } } catch { /* protocol diagnostics */ }
});
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve) => { pending.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
}
function result(message) {
  const text = message.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : { status: 'error', error: message.error?.message ?? 'MCP request failed' };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const transcript = [];
async function tool(name, args) {
  const response = await call('tools/call', { name, arguments: args });
  const value = result(response);
  transcript.push({ tool: name, arguments: args, result: value });
  return value;
}
async function main() {
  await call('initialize', { protocolVersion: '2024-11-05' });
  const listed = await call('tools/list', {});
  const names = listed.result?.tools?.map((entry) => entry.name) ?? [];
  for (const name of ['run_r', 'monitor_console_run', 'get_run_result']) if (!names.includes(name)) throw new Error(`missing ${name}`);
  const proposal = { language: 'R', target: 'console', code: RUN_CODE };
  const deadline = Date.now() + 90000;
  let runId;
  while (Date.now() < deadline) {
    const submitted = await tool('run_r', { proposal });
    if (submitted.status === 'approval_required') { await sleep(250); continue; }
    if (!submitted.run_id) throw new Error(`run_r did not queue: ${JSON.stringify(submitted)}`);
    runId = submitted.run_id;
    break;
  }
  if (!runId) throw new Error('approval was not completed');
  // Observe the same run only. Native capture can release its slot before the
  // final R result is stored; retry that documented pending transition boundedly.
  const monitorDeadline = Date.now() + 60000;
  let monitored;
  do {
    monitored = await tool('monitor_console_run', { run_id: runId });
    if (monitored.status !== 'finalization_pending') break;
    if (Date.now() >= monitorDeadline) throw new Error(`run never finalized: ${JSON.stringify(monitored)}`);
    await sleep(150);
  } while (true);
  if (monitored.status !== 'not_running' || monitored.run_id !== runId ||
      monitored.completion_verified !== true) throw new Error(`unexpected monitor outcome: ${JSON.stringify(monitored)}`);
  const final = await tool('get_run_result', { run_id: runId });
  if (final.status !== 'ok' || !String(final.stdout ?? '').includes('RAI_MONITOR_DONE')) throw new Error(`unexpected final result: ${JSON.stringify(final)}`);
  writeFileSync(`${stateDir}/console-monitor-data.json`, JSON.stringify({ run_id: runId, monitor_result: monitored, final_result: final, transcript }, null, 2));
  log('[fake-provider-console-monitor] data written');
  await sleep(30000);
}
main().catch((error) => { log(`[fake-provider-console-monitor] fatal: ${error.stack ?? error}`); writeFileSync(`${stateDir}/error.txt`, String(error?.stack ?? error)); process.exitCode = 1; }).finally(() => child.kill());
