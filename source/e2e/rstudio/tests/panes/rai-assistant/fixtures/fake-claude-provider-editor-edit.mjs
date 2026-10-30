#!/usr/bin/env node
// Test-only provider for the complete open-editor MCP workflow: enumerate the
// current open documents, read one R document, request one exact replacement,
// poll the automatic no-card apply, then prove the settled result.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const configPath = arg('--mcp-config');
const stateDir = arg('--test-state-dir');
if (!configPath || !stateDir) process.exit(1);
mkdirSync(stateDir, { recursive: true });
writeFileSync(`${stateDir}/provider.pid`, String(process.pid));

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const scenarioPath = `${stateDir}/scenario.json`;
const scenario = existsSync(scenarioPath) ? JSON.parse(readFileSync(scenarioPath, 'utf8')) : {};
const server = sessionMcpServer(config);
if (!server) process.exit(1);
const child = spawn(server.command, server.args ?? [], {
  env: { ...process.env, ...(server.env ?? {}) },
  stdio: ['pipe', 'pipe', 'inherit'],
});
writeFileSync(`${stateDir}/mcp.pid`, String(child.pid));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { child.kill(signal); process.exit(0); });
}

const pending = new Map();
let nextId = 1;
readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
  try {
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  } catch { /* Ignore terminal noise; MCP uses JSONL only. */ }
});
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
function result(response) {
  const text = response.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : response.error;
}
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function tool(name, arguments_) {
  const response = await call('tools/call', { name, arguments: arguments_ });
  return result(response);
}

async function main() {
  await call('initialize', { protocolVersion: '2024-11-05' });
  const listed = await call('tools/list', {});
  const names = listed.result?.tools?.map((entry) => entry.name) ?? [];
  if (!names.includes('get_active_document_context') || !names.includes('list_open_documents') || !names.includes('read_open_document') || !names.includes('edit_document'))
    throw new Error(`editor MCP tools are unavailable: ${JSON.stringify(names)}`);

  if (scenario.mode === 'expect_inactive_after_signal') {
    writeFileSync(`${stateDir}/provider-ready`, 'ready');
    const deadline = Date.now() + 30000;
    while (!existsSync(`${stateDir}/proceed`) && Date.now() < deadline)
      await sleep(100);
    if (!existsSync(`${stateDir}/proceed`))
      throw new Error('timed out waiting for the test to close the focused document');
  }

  const active = await tool('get_active_document_context', {});
  if (scenario.mode === 'expect_inactive' || scenario.mode === 'expect_inactive_after_signal') {
    if (active.active !== false)
      throw new Error(`inactive active-document context was expected: ${JSON.stringify(active)}`);
    writeFileSync(`${stateDir}/result.json`, JSON.stringify({ status: 'inactive' }));
    await sleep(60000);
    return;
  }
  if (active.active !== true || typeof active.document_id !== 'string' || active.document_id.length === 0 ||
      active.type !== 'r_source' || typeof active.dirty !== 'boolean' || typeof active.read_only !== 'boolean')
    throw new Error(`active editor context is not bounded eligible metadata: ${JSON.stringify(active)}`);

  const documents = await tool('list_open_documents', {});
  const documentId = documents.documents?.find((document) => document.document_id === active.document_id)?.document_id;
  if (!documentId) throw new Error(`active R document is not listed as open: ${JSON.stringify({ active, documents })}`);
  const document = await tool('read_open_document', { document_id: documentId });
  const expectedText = 'threshold <- 0.05';
  const replacement = 'threshold <- 0.01';
  if (!String(document.contents ?? '').includes(expectedText))
    throw new Error('the actual open source document did not contain the requested old text');

  if (active.read_only === true) {
    const rejected = await tool('edit_document', { document_id: documentId, expected_text: expectedText, replacement });
    if (!/read-only/i.test(JSON.stringify(rejected)))
      throw new Error(`read-only document edit was not rejected: ${JSON.stringify(rejected)}`);
    writeFileSync(`${stateDir}/result.json`, JSON.stringify({
      status: 'rejected', document_id: documentId, read_only: true,
    }));
    await sleep(60000);
    return;
  }
  if (active.read_only !== false)
    throw new Error(`active editor read-only metadata is invalid: ${JSON.stringify(active)}`);

  const deadline = Date.now() + 90000;
  const editArgs = { document_id: documentId, expected_text: expectedText, replacement };
  if (scenario.mode === 'expect_put_failure') {
    writeFileSync(`${stateDir}/provider-ready`, documentId);
    while (!existsSync(`${stateDir}/proceed`) && Date.now() < deadline)
      await sleep(100);
    if (!existsSync(`${stateDir}/proceed`))
      throw new Error('timed out waiting for isolated source database failure setup');
  }
  if (scenario.mode === 'expect_stale_after_read') {
    writeFileSync(`${stateDir}/proposal-ready`, 'ready');
    const changeDeadline = Date.now() + 30000;
    while (!existsSync(`${stateDir}/buffer-changed`) && Date.now() < changeDeadline)
      await sleep(100);
    if (!existsSync(`${stateDir}/buffer-changed`))
      throw new Error('timed out waiting for the test to change the buffer before the edit');
  }
  const requested = await tool('edit_document', editArgs);
  if (scenario.mode === 'expect_put_failure' || scenario.mode === 'expect_trace_failure') {
    if (!['applying', 'error'].includes(requested.status))
      throw new Error(`expected native failure path: ${JSON.stringify(requested)}`);
    let settled = requested;
    while (settled.status === 'applying' && Date.now() < deadline) {
      await sleep(250);
      settled = await tool('edit_document', editArgs);
    }
    const updated = await tool('read_open_document', { document_id: documentId });
    writeFileSync(`${stateDir}/result.json`, JSON.stringify({
      status: settled.status, message: settled.message ?? null,
      buffer_unchanged: updated.contents === document.contents,
      trace_seq: settled.trace?.seq ?? null,
    }));
    await sleep(60000);
    return;
  }
  if (scenario.mode === 'expect_full_auto') {
    // Full Auto: no card. The request reports applying (or already applied);
    // poll with IDENTICAL arguments until native reports the terminal outcome.
    if (requested.status !== 'applying' && requested.status !== 'applied')
      throw new Error(`expected an automatic edit: ${JSON.stringify(requested)}`);
    let settled = requested;
    while (settled.status === 'applying' && Date.now() < deadline) {
      await sleep(250);
      settled = await tool('edit_document', editArgs);
    }
    const updated = await tool('read_open_document', { document_id: documentId });
    writeFileSync(`${stateDir}/result.json`, JSON.stringify({
      status: settled.status, approval: requested.approval, document_id: documentId,
      expected_text: expectedText, replacement,
      message: settled.message ?? null,
      buffer_has_replacement: String(updated.contents ?? '').includes(replacement),
      trace_seq: settled.trace?.seq ?? null,
    }));
    await sleep(60000);
    return;
  }
  if (scenario.mode === 'expect_stale_after_read') {
    let settled = requested;
    while (settled.status === 'applying' && Date.now() < deadline) {
      await sleep(250);
      settled = await tool('edit_document', editArgs);
    }
    const updated = await tool('read_open_document', { document_id: documentId });
    if (String(updated.contents ?? '') !== 'threshold <- 0.02')
      throw new Error(`stale edit changed the editor: ${JSON.stringify(updated)}`);
    // The buffer changed after read_open_document and before edit_document, so
    // the read token no longer matches and the request is refused. This does
    // not exercise the apply-time revalidation: no hook can change the buffer
    // between queue and apply in a release build.
    if (settled.status !== 'error' || !/document changed|file changed since read/i.test(String(settled.message ?? '')))
      throw new Error(`stale edit was not refused: ${JSON.stringify(settled)}`);
    writeFileSync(`${stateDir}/result.json`, JSON.stringify({ status: 'stale', document_id: documentId }));
    await sleep(60000);
    return;
  }
  if (requested.status !== 'applying' && requested.status !== 'applied')
    throw new Error(`expected an automatic edit: ${JSON.stringify(requested)}`);
  let settled = requested;
  while (settled.status === 'applying' && Date.now() < deadline) {
    await sleep(250);
    settled = await tool('edit_document', editArgs);
  }
  if (settled.status !== 'applied')
    throw new Error(`automatic edit did not apply: ${JSON.stringify(settled)}`);
  writeFileSync(`${stateDir}/result.json`, JSON.stringify({
    status: 'applied', document_id: documentId, expected_text: expectedText, replacement,
    approval: requested.approval ?? 'autonomous',
  }));
  await sleep(60000);
}

main().catch((error) => {
  writeFileSync(`${stateDir}/error.txt`, String(error?.stack ?? error));
  process.exitCode = 1;
}).finally(() => child.kill());
