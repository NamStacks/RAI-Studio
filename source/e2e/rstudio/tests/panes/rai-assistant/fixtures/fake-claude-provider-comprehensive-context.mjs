#!/usr/bin/env node
// Deterministic, test-only MCP client for the single comprehensive RAI
// Assistant workflow: bounded project file read, open-editor inspection,
// live Console execution, environment summary, read-only existing-plot PNG
// context, and one exact native buffer edit -- all in one live session.
//
// Every call is real MCP JSON-RPC against the packaged bridge/native
// session; only the "LLM decision" of which tool to call next is scripted.
// The plot read here is deliberately read-only: the plot itself was already
// rendered by the Playwright test's own Console harness call BEFORE this
// provider ever launches (see rai-comprehensive-context-scripted.test.ts),
// so get_plot_image proves it reads pre-existing state rather than
// something it caused, and the test can assert the plot history/active
// index is unchanged by the read. Negative boundaries (rejected traversal
// and absolute file reads) are proven against the same live
// read_project_file endpoint the positive read used.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
export const EXPECTED_TEXT = 'threshold <- 0.5';
export const REPLACEMENT_TEXT = 'threshold <- 0.9';

function findArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configPath = findArg('--mcp-config');
const stateDir = findArg('--test-state-dir');
if (!configPath || !stateDir)
  throw new Error('comprehensive-context provider requires --mcp-config and --test-state-dir');

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

async function toolCall(name, args) {
  const response = await call('tools/call', { name, arguments: args });
  const result = textToolResult(response);
  transcript.push({ tool: name, arguments: args, response, result });
  return { response, result };
}

// Raw JSON-RPC/tool-result envelope preserved separately from textToolResult
// above: a rejected read_project_file call may surface as either a JSON-RPC
// error or a text tool-result error field, and this must not assume which.
async function toolCallRaw(name, args) {
  const response = await call('tools/call', { name, arguments: args });
  transcript.push({ tool: name, arguments: args, response });
  return response;
}

function imageMetadata(response) {
  const image = response.result?.content?.[0];
  if (!image || image.type !== 'image' || image.mimeType !== 'image/png' || typeof image.data !== 'string')
    throw new Error(`get_plot_image did not return MCP PNG image content: ${JSON.stringify(response)}`);
  const bytes = Buffer.from(image.data, 'base64');
  return {
    type: image.type,
    mimeType: image.mimeType,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    signature: [...bytes.subarray(0, PNG_SIGNATURE.length)],
  };
}

async function main() {
  transcript.push({ method: 'initialize', response: await call('initialize', { protocolVersion: '2024-11-05' }) });
  const listed = await call('tools/list', {});
  const names = listed.result?.tools?.map((entry) => entry.name) ?? [];
  for (const required of [
    'read_project_file', 'get_active_document_context', 'list_open_documents',
    'read_open_document', 'run_r', 'get_run_result', 'get_environment_summary',
    'get_plot_history', 'get_plot_image', 'edit_document',
  ]) {
    if (!names.includes(required))
      throw new Error(`comprehensive workflow requires tool "${required}", got: ${JSON.stringify(names)}`);
  }

  // 1. Bounded project-relative file read.
  const fileRead = await toolCall('read_project_file', { path: 'notes.txt' });

  // 1b. Negative boundary probes against the SAME live endpoint: traversal
  // and absolute paths must be explicit MCP errors, never file contents.
  const traversalAttempt = await toolCallRaw('read_project_file', { path: '../notes.txt' });
  const absoluteAttempt = await toolCallRaw('read_project_file', { path: '/etc/hosts' });

  // 2. Live open-editor inspection: active document metadata, then contents.
  const active = await toolCall('get_active_document_context', {});
  if (active.result.active !== true || typeof active.result.document_id !== 'string')
    throw new Error(`active editor context is not eligible: ${JSON.stringify(active.result)}`);
  const documentId = active.result.document_id;
  const documents = await toolCall('list_open_documents', {});
  if (!documents.result.documents?.some((document) => document.document_id === documentId))
    throw new Error(`active document is not listed as open: ${JSON.stringify(documents.result)}`);
  const openDocument = await toolCall('read_open_document', { document_id: documentId });
  if (!String(openDocument.result.contents ?? '').includes(EXPECTED_TEXT))
    throw new Error('open document did not contain the expected pre-edit text');

  // 3. Console run/result: proposal is gated on the native approval card;
  // repeated calls with the same proposal dedupe to the same run (proposal
  // fingerprint), so this loop simply waits for the Playwright test to click
  // "Allow once" on the resulting card.
  // One braced R expression keeps the strict Console transport parser-valid
  // while retaining assignment plus visible native Console output.
  const proposal = { language: 'R', target: 'console', code: '{ rai_comp_result <- 6L * 7L; print(rai_comp_result) }' };
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

  let runResult;
  while (Date.now() < runDeadline) {
    const readResult = await toolCall('get_run_result', { run_id: runId });
    if (readResult.result.status === 'pending') {
      await sleep(250);
      continue;
    }
    runResult = readResult.result;
    break;
  }
  if (!runResult)
    throw new Error(`timed out waiting for get_run_result(${runId})`);
  if (runResult.status !== 'ok' || !String(runResult.stdout ?? '').includes('42'))
    throw new Error(`Console run did not produce the expected result: ${JSON.stringify(runResult)}`);

  // 4. Environment summary: bounded listing plus named detail for the value
  // the Console run above just created.
  const environmentListing = await toolCall('get_environment_summary', {});
  const environmentDetail = await toolCall('get_environment_summary', { object_names: ['rai_comp_result'] });

  // 5. Read-only EXISTING plot PNG context. The plot itself was already
  // rendered by the test's own non-MCP Console harness call before this
  // provider launched -- no run_r/get_run_result for a plot happens here.
  const plotHistoryBefore = await toolCall('get_plot_history', {});
  const plotImageResponse = await call('tools/call', { name: 'get_plot_image', arguments: {} });
  transcript.push({ tool: 'get_plot_image', arguments: {}, response: plotImageResponse });
  const plotImage = imageMetadata(plotImageResponse);
  const plotHistoryAfter = await toolCall('get_plot_history', {});

  // 6. Exact native buffer edit against the same open document read in
  // step 2. Full Auto is explicitly enabled by this fixture: native must
  // apply without a card and report a terminal result for this exact request.
  const editArgs = {
    document_id: documentId,
    expected_text: EXPECTED_TEXT,
    replacement: REPLACEMENT_TEXT,
  };
  const editRequest = await toolCall('edit_document', editArgs);
  if (editRequest.result.status !== 'applying' || editRequest.result.approval !== 'autonomous')
    throw new Error(`expected native Full Auto edit application: ${JSON.stringify(editRequest.result)}`);
  const editDeadline = Date.now() + 90000;
  let settled;
  while (Date.now() < editDeadline) {
    const observed = await toolCall('edit_document', editArgs);
    if (observed.result.status === 'applied') { settled = observed.result; break; }
    if (observed.result.status !== 'applying')
      throw new Error(`native edit failed: ${JSON.stringify(observed.result)}`);
    await sleep(250);
  }
  if (!settled || !settled.trace?.seq)
    throw new Error(`native Full Auto edit did not settle with trace: ${JSON.stringify(settled)}`);
  let applied;
  while (Date.now() < editDeadline) {
    const updated = await toolCall('read_open_document', { document_id: documentId });
    if (String(updated.result.contents ?? '').includes(REPLACEMENT_TEXT)) {
      applied = updated.result.contents;
      break;
    }
    await sleep(250);
  }
  if (!applied)
    throw new Error('timed out waiting for the approved editor replacement to apply');

  writeFileSync(`${stateDir}/comprehensive-data.json`, JSON.stringify({
    file_read: fileRead.result,
    traversal_error: traversalAttempt.error ?? traversalAttempt.result,
    absolute_error: absoluteAttempt.error ?? absoluteAttempt.result,
    active_document: active.result,
    open_documents: documents.result,
    open_document_before_edit: openDocument.result,
    console_run_id: runId,
    console_run_result: runResult,
    environment_listing: environmentListing.result,
    environment_detail: environmentDetail.result,
    plot_history_before: plotHistoryBefore.result,
    plot_history_after: plotHistoryAfter.result,
    plot_image: plotImage,
    edit_document_id: documentId,
    applied_document_contents: applied,
    transcript,
  }, null, 2));
  log('[fake-provider-comprehensive-context] data written');

  // Keep the provider/Assistant iframe stable until fixture teardown.
  await sleep(90000);
}

main().catch((error) => {
  log(`[fake-provider-comprehensive-context] fatal: ${error.stack ?? error}`);
  writeFileSync(`${stateDir}/error.txt`, String(error?.stack ?? error));
  process.exitCode = 1;
}).finally(() => child.kill());
