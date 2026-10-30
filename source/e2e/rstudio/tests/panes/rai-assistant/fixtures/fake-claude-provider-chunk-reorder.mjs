#!/usr/bin/env node
// Regression guard for the dependency-REORDER half of the Console audit
// contract (prompts/RAI-Assistant.md item 3): when a later chunk needs an
// object a chunk placed AFTER it provides, a plain top-down run draws the
// wrong result, and the Assistant must physically move the source chunks so
// the dependency comes first -- not hand the user a manual run order.
//
// Every other audit fixture in this suite fixes a chunk IN PLACE
// (multi-chunk-audit rewrites one buggy line). None of them moves a chunk,
// so none of them could catch a build that "fixes" a dependency-order
// problem by running the chunks out of file order and leaving the file
// itself still broken.
//
// The proof that the reorder is real, and not just a lucky run order, is the
// deliberate environment reset in the middle: every binding the first pass
// created is removed before the second top-down pass, so the second pass can
// only succeed because the FILE now has the producer ahead of its consumer.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

// Written to the file in the WRONG order on purpose: the consumer is first.
export const CHUNK_CONSUMER =
  '{ rai_reorder_scaled <- rai_reorder_base * 3L; print(rai_reorder_scaled) }';
export const CHUNK_PRODUCER = 'rai_reorder_base <- 7L';
export const SOURCE_ORIGINAL = `${CHUNK_CONSUMER}\n\n${CHUNK_PRODUCER}\n`;
export const SOURCE_REORDERED = `${CHUNK_PRODUCER}\n\n${CHUNK_CONSUMER}\n`;
// Only reachable when the producer genuinely runs first against a clean slate.
const EXPECTED_SCALED = 7 * 3;
const RESET_CODE =
  'rm(list = c("rai_reorder_base", "rai_reorder_scaled"))';

function findArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configPath = findArg('--mcp-config');
const stateDir = findArg('--test-state-dir');
if (!configPath || !stateDir)
  throw new Error('chunk-reorder provider requires --mcp-config and --test-state-dir');

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
const stepLog = [];

async function toolCall(name, args) {
  const response = await call('tools/call', { name, arguments: args });
  const result = textToolResult(response);
  transcript.push({ tool: name, arguments: args, response, result });
  return { response, result };
}

async function runAndAwait(code) {
  const proposal = { language: 'R', target: 'console', code };
  const deadline = Date.now() + 60000;
  let runId;
  while (Date.now() < deadline) {
    const run = await toolCall('run_r', { proposal });
    if (run.result.status === 'approval_required') {
      await sleep(200);
      continue;
    }
    if (!run.result.run_id)
      throw new Error(`run_r did not return a run_id: ${JSON.stringify(run.result)}`);
    runId = run.result.run_id;
    break;
  }
  if (!runId)
    throw new Error(`timed out waiting for approval of proposal: ${code}`);

  while (Date.now() < deadline) {
    const readResult = await toolCall('get_run_result', { run_id: runId });
    if (readResult.result.status === 'pending' || readResult.result.status === 'running') {
      await sleep(200);
      continue;
    }
    return readResult.result;
  }
  throw new Error(`timed out waiting for get_run_result(${runId})`);
}

// The source file is the authority for run order: blocks come back in the
// order they physically appear, so a "top-down run" here is literally a walk
// of the file as written, never a reordering applied by this client.
function blocksInFileOrder(contents) {
  return String(contents ?? '')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

async function runTopDown(contents, label) {
  const results = [];
  const blocks = blocksInFileOrder(contents);
  for (let index = 0; index < blocks.length; index++) {
    const result = await runAndAwait(blocks[index]);
    results.push({ index, code: blocks[index], status: result.status,
      stdout: result.stdout ?? null, stderr: result.stderr ?? null });
    stepLog.push({ pass: label, index, status: result.status });
  }
  return results;
}

async function environmentFound(names) {
  const summary = await toolCall('get_environment_summary', { object_names: names });
  const objects = summary.result.objects ?? [];
  return Object.fromEntries(names.map((name) =>
    [name, Boolean(objects.find((object) => object.name === name)?.found)]));
}

async function main() {
  transcript.push({ method: 'initialize', response: await call('initialize', { protocolVersion: '2024-11-05' }) });
  const listed = await call('tools/list', {});
  const names = listed.result?.tools?.map((entry) => entry.name) ?? [];
  for (const required of ['run_r', 'get_run_result', 'get_environment_summary',
    'get_active_document_context', 'read_open_document', 'edit_document']) {
    if (!names.includes(required))
      throw new Error(`chunk-reorder workflow requires tool "${required}", got: ${JSON.stringify(names)}`);
  }

  const active = await toolCall('get_active_document_context', {});
  if (active.result.active !== true || typeof active.result.document_id !== 'string')
    throw new Error(`active editor context is not eligible for the reorder: ${JSON.stringify(active.result)}`);
  const documentId = active.result.document_id;

  const originalDocument = await toolCall('read_open_document', { document_id: documentId });
  if (originalDocument.result.contents !== SOURCE_ORIGINAL)
    throw new Error(`open buffer is not the expected mis-ordered source: ${JSON.stringify(originalDocument.result)}`);

  // --- Pass 1: run the file top-down EXACTLY as written. The consumer comes
  // first, so it must genuinely fail on a missing object -- this is the
  // wrong-order symptom, observed, not assumed. -----------------------------
  const firstPass = await runTopDown(originalDocument.result.contents, 'as-written');
  if (firstPass.length !== 2)
    throw new Error(`expected two top-level blocks in the source, got ${firstPass.length}`);
  if (firstPass[0].status !== 'error')
    throw new Error(`the as-written first block should have failed on the missing binding: ${JSON.stringify(firstPass[0])}`);
  if (!String(firstPass[0].stderr ?? '').match(/rai_reorder_base|not found/i))
    throw new Error(`first block error did not name the missing object: ${JSON.stringify(firstPass[0])}`);
  if (firstPass[1].status !== 'ok')
    throw new Error(`the as-written second block (the producer) should have run clean: ${JSON.stringify(firstPass[1])}`);

  // --- Fix: MOVE the producer ahead of its consumer in the real source
  // buffer. One anchored replacement covering both blocks, so the reorder is
  // atomic and the native buffer audit can see the line count is unchanged. --
  const editRequest = await toolCall('edit_document', {
    document_id: documentId,
    expected_text: `${CHUNK_CONSUMER}\n\n${CHUNK_PRODUCER}`,
    replacement: `${CHUNK_PRODUCER}\n\n${CHUNK_CONSUMER}`,
  });
  stepLog.push({ step: 'edit_document', status: editRequest.result.status });

  const editDeadline = Date.now() + 60000;
  let reorderedContents;
  while (Date.now() < editDeadline) {
    const updated = await toolCall('read_open_document', { document_id: documentId });
    if (String(updated.result.contents ?? '') === SOURCE_REORDERED) {
      reorderedContents = updated.result.contents;
      break;
    }
    await sleep(250);
  }
  if (!reorderedContents)
    throw new Error('timed out waiting for the reordered source to apply to the open buffer');

  // --- Reset: drop everything pass 1 created. Without this, pass 2 could
  // "succeed" purely because the producer already ran once, and the reorder
  // would never actually be under test. -------------------------------------
  const resetResult = await runAndAwait(RESET_CODE);
  stepLog.push({ step: 'reset', status: resetResult.status });
  if (resetResult.status !== 'ok')
    throw new Error(`environment reset failed: ${JSON.stringify(resetResult)}`);
  const clearedEnvironment = await environmentFound(['rai_reorder_base', 'rai_reorder_scaled']);
  if (clearedEnvironment.rai_reorder_base || clearedEnvironment.rai_reorder_scaled)
    throw new Error(`environment reset left a binding behind: ${JSON.stringify(clearedEnvironment)}`);

  // --- Pass 2: run the file top-down again, re-reading it from the buffer so
  // the order under test is the FILE's own order. Both blocks must now run
  // clean and produce the dependent value. -----------------------------------
  const secondPass = await runTopDown(reorderedContents, 'reordered');
  if (secondPass.length !== 2)
    throw new Error(`expected two top-level blocks after the reorder, got ${secondPass.length}`);
  if (secondPass[0].code !== CHUNK_PRODUCER)
    throw new Error(`the reordered file does not run the producer first: ${JSON.stringify(secondPass[0])}`);
  for (const entry of secondPass) {
    if (entry.status !== 'ok')
      throw new Error(`reordered top-down pass still failed: ${JSON.stringify(entry)}`);
  }
  if (!String(secondPass[1].stdout ?? '').includes(String(EXPECTED_SCALED)))
    throw new Error(`reordered run did not produce ${EXPECTED_SCALED}: ${JSON.stringify(secondPass[1])}`);

  const finalEnvironment = await environmentFound(['rai_reorder_base', 'rai_reorder_scaled']);
  if (!finalEnvironment.rai_reorder_base || !finalEnvironment.rai_reorder_scaled)
    throw new Error(`reordered run did not leave both bindings: ${JSON.stringify(finalEnvironment)}`);

  writeFileSync(`${stateDir}/chunk-reorder-data.json`, JSON.stringify({
    step_log: stepLog,
    document_id: documentId,
    original_contents: originalDocument.result.contents,
    first_pass: firstPass,
    edit_status: editRequest.result.status ?? null,
    reordered_contents: reorderedContents,
    reset_result: resetResult,
    cleared_environment: clearedEnvironment,
    second_pass: secondPass,
    final_environment: finalEnvironment,
    transcript,
  }, null, 2));
  log('[fake-provider-chunk-reorder] data written');

  await sleep(30000);
}

main().catch((error) => {
  log(`[fake-provider-chunk-reorder] fatal: ${error.stack ?? error}`);
  writeFileSync(`${stateDir}/error.txt`, String(error?.stack ?? error));
  process.exitCode = 1;
}).finally(() => child.kill());
