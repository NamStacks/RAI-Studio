#!/usr/bin/env node
// Deterministic Stage 1 debugging matrix provider. This is test-only: every
// accepted proposal takes the real native approval -> Console -> result path,
// then exactly one read-only get_debug_info({run_id}). Raw JSON-RPC envelopes
// are preserved so the UI test can prove every diagnostic was structured and
// no debug read submitted Console input.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

function arg(name) { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }
const configPath = arg('--mcp-config');
const stateDir = arg('--test-state-dir');
if (!configPath || !stateDir) throw new Error('stage1 matrix provider requires --mcp-config and --test-state-dir');
mkdirSync(stateDir, { recursive: true });
writeFileSync(`${stateDir}/provider.pid`, String(process.pid));
const scenario = JSON.parse(readFileSync(`${stateDir}/scenario.json`, 'utf8'));

function log(line) { process.stdout.write(`${line}\n`); appendFileSync(`${stateDir}/provider.log`, `${line}\n`); }
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const server = sessionMcpServer(config);
if (!server) throw new Error('MCP config has no rai server');
const child = spawn(server.command, server.args ?? [], { env: { ...process.env, ...(server.env ?? {}) }, stdio: ['pipe', 'pipe', 'inherit'] });
writeFileSync(`${stateDir}/mcp.pid`, String(child.pid));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); process.exit(0); });

const pending = new Map(); let nextId = 1;
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
lines.on('line', (line) => { try { const message = JSON.parse(line); const resolve = pending.get(message.id); if (resolve) { pending.delete(message.id); resolve(message); } } catch {} });
function call(method, params) { const id = nextId++; return new Promise((resolve) => { pending.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }); }
function resultOf(response) { const text = response.result?.content?.[0]?.text; if (text) { try { return JSON.parse(text); } catch (error) { return { status: 'error', error: `invalid tool JSON: ${error.message}` }; } } return { status: 'error', error: response.error?.message ?? 'MCP request failed' }; }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deadline() { return Date.now() + 120000; }

async function callTool(transcript, tool, arguments_) {
  const response = await call('tools/call', { name: tool, arguments: arguments_ });
  const result = resultOf(response);
  transcript.push({ tool, arguments: arguments_, response, result });
  return result;
}
async function submit(transcript, proposal) {
  const until = deadline(); let runId;
  while (Date.now() < until) {
    const response = await callTool(transcript, 'run_r', { proposal });
    if (response.status === 'approval_required') { await sleep(200); continue; }
    if (!response.run_id) throw new Error(`run_r did not produce run_id for ${JSON.stringify(proposal)}: ${JSON.stringify(response)}`);
    runId = response.run_id; break;
  }
  if (!runId) throw new Error(`timed out awaiting approval for ${proposal.code}`);
  let result;
  while (Date.now() < until) {
    result = await callTool(transcript, 'get_run_result', { run_id: runId });
    if (result.status !== 'pending') break;
    await sleep(200);
  }
  if (!result || result.status === 'pending') throw new Error(`timed out awaiting get_run_result(${runId})`);
  // This is deliberately the only debug read per accepted run. Its argument
  // object contains exactly run_id, enforcing the Stage 1 read-only contract.
  const debug = await callTool(transcript, 'get_debug_info', { run_id: runId });
  return { run_id: runId, result, debug };
}
function derivedCode(derive, feedback) {
  const escaped = derive.tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}=(-?\\d+(?:\\.\\d+)?)`).exec(feedback);
  if (!match) throw new Error(`cannot build correction: ${derive.tag}=number absent from actual feedback ${feedback}`);
  return `${derive.prefix}${match[1]}${derive.suffix}`;
}
function assertStructured(step, record) {
  if (record.result.status !== step.expect.status) throw new Error(`${step.label}: expected result ${step.expect.status}, got ${JSON.stringify(record.result)}`);
  if (!record.debug || record.debug.status !== step.expect.status) throw new Error(`${step.label}: missing matching structured debug result ${JSON.stringify(record.debug)}`);
  const debugText = JSON.stringify(record.debug);
  if (step.expect.error && !debugText.includes(step.expect.error)) throw new Error(`${step.label}: debug missing expected error ${step.expect.error}: ${debugText}`);
  if (step.expect.warnings) {
    if (!Array.isArray(record.debug.warnings) || record.debug.warnings.length !== step.expect.warnings.length) throw new Error(`${step.label}: structured warnings missing/incorrect: ${debugText}`);
    for (const warning of step.expect.warnings) if (!JSON.stringify(record.debug.warnings).includes(warning)) throw new Error(`${step.label}: structured warning missing ${warning}: ${debugText}`);
  }
  if (!step.expect.error && !step.expect.warnings && (record.debug.warnings?.length || record.debug.error_detail)) throw new Error(`${step.label}: clean debug unexpectedly had diagnostics: ${debugText}`);
}

async function main() {
  const transcript = [];
  const init = await call('initialize', { protocolVersion: '2024-11-05' });
  transcript.push({ tool: 'initialize', arguments: {}, response: init, result: resultOf(init) });
  const runs = []; const planning = [];
  if (scenario.debugOnlyIds) {
    for (const run_id of scenario.debugOnlyIds) await callTool(transcript, 'get_debug_info', { run_id });
  } else {
    for (const step of scenario.steps ?? []) {
      let code = step.code;
      if (step.derive) {
        const previous = runs.at(-1);
        if (!previous) throw new Error(`${step.label}: correction has no previous result`);
        const feedback = JSON.stringify({ result: previous.result, debug: previous.debug });
        code = derivedCode(step.derive, feedback);
        planning.push({ label: step.label, feedback, code });
      }
      const proposal = { language: 'R', target: 'console', code };
      log(`[stage1-matrix] ${scenario.id}/${step.label} -> ${JSON.stringify(proposal)}`);
      const settled = await submit(transcript, proposal);
      const record = { label: step.label, proposal, ...settled };
      assertStructured(step, record);
      runs.push(record);
      writeFileSync(`${stateDir}/stage1-evidence.json`, JSON.stringify({ runs, transcript, planning }, null, 2));
      log(`[stage1-matrix] ${scenario.id}/${step.label} <- ${JSON.stringify({ result: settled.result, debug: settled.debug })}`);
    }
  }
  writeFileSync(`${stateDir}/stage1-evidence.json`, JSON.stringify({ runs, transcript, planning }, null, 2));
  log(`[stage1-matrix] COMPLETE ${scenario.id}`);
}
main().catch((error) => { log(`[stage1-matrix] FATAL ${error.stack ?? error}`); process.exitCode = 1; }).finally(() => child.kill());
