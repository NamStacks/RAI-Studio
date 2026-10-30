#!/usr/bin/env node
// Deterministic, test-only MCP client used by the R-only acceptance matrix.
// Its scenario is written by scripted-rai.fixture.ts into the isolated state
// directory. Every proposal traverses the real bridge, native approval card,
// Console submission, and get_run_result protocol; only the LLM decision is
// fixed. Results are persisted after each proposal so a test can assert the
// complete native response sequence without relying on iframe scrollback.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

function findArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configPath = findArg('--mcp-config');
const stateDir = findArg('--test-state-dir');
if (!configPath || !stateDir)
  throw new Error('fake matrix provider requires --mcp-config and --test-state-dir');

mkdirSync(stateDir, { recursive: true });
writeFileSync(`${stateDir}/provider.pid`, String(process.pid));
const instructionFlag = process.argv.indexOf('--append-system-prompt-file');
if (instructionFlag >= 0) writeFileSync(`${stateDir}/instructions-path`, process.argv[instructionFlag + 1]);
const scenario = JSON.parse(readFileSync(`${stateDir}/scenario.json`, 'utf8'));
if (!Array.isArray(scenario.proposals))
  throw new Error('matrix scenario must contain a proposals array');

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
    // MCP is JSON-lines; ignore any non-protocol diagnostics.
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
  if (text) return JSON.parse(text);
  return { status: 'error', error: msg.error?.message ?? 'MCP request failed' };
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const deadline = () => Date.now() + 120000;

async function submit(proposal) {
  const until = deadline();
  while (Date.now() < until) {
    const response = await call('tools/call', { name: 'run_r', arguments: { proposal } });
    const result = toolResult(response);
    if (result.status === 'approval_required') {
      await sleep(250);
      continue;
    }
    if (!result.run_id)
      return result;

    // A repeated run_r call can observe a proposal while queued or after it
    // settles. Either response has the stable run ID; read Console feedback
    // exclusively through get_run_result.
    const runId = result.run_id;
    while (Date.now() < until) {
      const resultResponse = await call('tools/call', { name: 'get_run_result', arguments: { run_id: runId } });
      const settled = toolResult(resultResponse);
      if (settled.status !== 'pending')
        return settled;
      await sleep(250);
    }
  }
  return { status: 'error', error: 'matrix provider timed out waiting for a native result' };
}

async function waitForFile(name) {
  const until = deadline();
  while (Date.now() < until) {
    if (existsSync(`${stateDir}/${name}`))
      return;
    await sleep(100);
  }
  throw new Error(`matrix provider timed out waiting for ${name}`);
}

async function waitForExplicitSubmit() {
  await new Promise((resolve, reject) => {
    let input = '';
    const timer = setTimeout(() => reject(new Error('no explicit user Enter before deadline')), 120000);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on('data', bytes => {
      appendFileSync(`${stateDir}/draft-input.bin`, bytes);
      input += bytes.toString('utf8');
      if (!input.includes('\r')) return;
      clearTimeout(timer);
      if (scenario.expectedSnippet && !input.includes(scenario.expectedSnippet))
        reject(new Error('explicit send did not include the exact saved snippet'));
      else resolve();
    });
  });
}

async function main() {
  await call('initialize', { protocolVersion: '2024-11-05' });
  if (scenario.waitForSubmit === true) {
    log('[fake-provider-matrix] waiting for explicit Enter');
    await waitForExplicitSubmit();
  }
  if (typeof scenario.waitForFile === 'string') {
    log(`[fake-provider-matrix] waiting for ${scenario.waitForFile}`);
    await waitForFile(scenario.waitForFile);
  }
  const authorized = [];
  for (const item of scenario.authorizations ?? []) {
    const until = deadline();
    let result;
    do {
      result = toolResult(await call('tools/call', {
        name: 'authorize_existing_derived_binding', arguments: item
      }));
      if (result.status === 'approval_required') await sleep(250);
    } while (result.status === 'approval_required' && Date.now() < until);
    authorized.push({name: item.name, kind: item.kind, status: result.status});
    writeFileSync(`${stateDir}/authorized.json`, JSON.stringify(authorized));
    if (result.status !== 'authorized')
      throw new Error(`derived authorization failed for ${item.name}: ${result.status}`);
  }
  if (scenario.notebookObservation === true) {
    const active = toolResult(await call('tools/call', {
      name:'get_active_document_context',arguments:{} }));
    if (active.active !== true || typeof active.document_id !== 'string')
      throw new Error('no eligible active notebook document');
    const inventory = toolResult(await call('tools/call', {
      name:'list_notebook_outputs',arguments:{document_id:active.document_id} }));
    if (!/^[a-f0-9]{64}$/.test(inventory.content_digest ?? ''))
      throw new Error('notebook inventory lacked a document digest');
    writeFileSync(`${stateDir}/notebook-before.json`, JSON.stringify({active,inventory}));
    await waitForFile('notebook-buffer-edited');
    let changed;
    const until = deadline();
    do {
      changed = toolResult(await call('tools/call', {
        name:'get_active_document_context',arguments:{} }));
      if (changed.content_digest === inventory.content_digest) await sleep(250);
    } while (changed.content_digest === inventory.content_digest && Date.now() < until);
    const image = toolResult(await call('tools/call', {
      name:'get_notebook_output_image',arguments:{document_id:active.document_id,
        chunk_id:'cache_chunk',ordinal:'000001',expected_document_digest:inventory.content_digest} }));
    writeFileSync(`${stateDir}/notebook-after.json`, JSON.stringify({changed,image}));
  }
  const results = [];
  for (const proposal of scenario.proposals) {
    log(`[fake-provider-matrix] run_r -> ${JSON.stringify(proposal)}`);
    const result = await submit(proposal);
    results.push({ proposal, result });
    writeFileSync(`${stateDir}/results.json`, JSON.stringify(results));
    log(`[fake-provider-matrix] result <- ${JSON.stringify(result)}`);
  }
  // Keep the terminal session stable until fixture teardown; the bridge would
  // otherwise reconnect and recreate the iframe while assertions are running.
  await sleep(90000);
}

main().catch((error) => {
  log(`[fake-provider-matrix] fatal: ${error.stack ?? error}`);
  process.exitCode = 1;
}).finally(() => child.kill());
