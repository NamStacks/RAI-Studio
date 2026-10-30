#!/usr/bin/env node
// Regression guard for the full multi-chunk audit loop: run a chunk, detect
// a genuine failure, derive a fix, write the fix back to the SOURCE file via
// edit_document, re-run the corrected chunk to confirm it now passes, and
// only then proceed to the next chunk (which depends on the fixed value).
// This is the actual end-to-end behavior requested -- "run chunk by chunk,
// audit, fix, rewrite source, retest, then continue" -- which no existing
// fixture exercises. Every prior fixture either ran one isolated chunk or
// applied one edit with no dependent downstream chunk to prove the fix was
// real and not just cosmetic.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

// --- The three-chunk script under audit -----------------------------------
// Chunk 1: fine as-is.
// Chunk 2: BUGGY -- references an undefined object (typo: `bas` for `base`),
//   so running it errors. The fix is a one-line rename.
// Chunk 3: depends on chunk 2's corrected binding; only produces the right
//   value if chunk 2 was actually fixed and rerun, not just reported.
export const CHUNK_1 = 'base <- 10L';
export const CHUNK_2_ORIGINAL = 'rai_audit_scaled <- bas * 3L';
export const CHUNK_2_FIXED = 'rai_audit_scaled <- base * 3L';
export const CHUNK_3 = '{ rai_audit_total <- rai_audit_scaled + base; print(rai_audit_total) }';
export const SOURCE_ORIGINAL = `${CHUNK_1}\n\n${CHUNK_2_ORIGINAL}\n\n${CHUNK_3}\n`;
export const SOURCE_FIXED = `${CHUNK_1}\n\n${CHUNK_2_FIXED}\n\n${CHUNK_3}\n`;
const EXPECTED_TOTAL = 10 * 3 + 10; // 40, only reachable once chunk 2 is genuinely fixed

function findArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configPath = findArg('--mcp-config');
const stateDir = findArg('--test-state-dir');
if (!configPath || !stateDir)
  throw new Error('multi-chunk-audit provider requires --mcp-config and --test-state-dir');

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

async function main() {
  transcript.push({ method: 'initialize', response: await call('initialize', { protocolVersion: '2024-11-05' }) });
  const listed = await call('tools/list', {});
  const names = listed.result?.tools?.map((entry) => entry.name) ?? [];
  for (const required of ['read_project_file', 'get_active_document_context', 'run_r', 'get_run_result', 'get_environment_summary', 'edit_document', 'read_open_document']) {
    if (!names.includes(required))
      throw new Error(`multi-chunk-audit workflow requires tool "${required}", got: ${JSON.stringify(names)}`);
  }

  // --- Chunk 1: run, verify ok, verify environment. -------------------------
  const chunk1Result = await runAndAwait(CHUNK_1);
  stepLog.push({ chunk: 1, status: chunk1Result.status });
  if (chunk1Result.status !== 'ok')
    throw new Error(`chunk 1 unexpectedly failed: ${JSON.stringify(chunk1Result)}`);
  const chunk1Env = await toolCall('get_environment_summary', { object_names: ['base'] });
  const baseEntry = chunk1Env.result.objects?.find((object) => object.name === 'base');
  if (!baseEntry?.found)
    throw new Error(`chunk 1 did not bind "base" in the environment: ${JSON.stringify(chunk1Env.result)}`);

  // --- Chunk 2: run the ORIGINAL buggy version; this must genuinely error,
  // not be a fixture that already "knows" the fix. ---------------------------
  const chunk2FirstResult = await runAndAwait(CHUNK_2_ORIGINAL);
  stepLog.push({ chunk: '2-original', status: chunk2FirstResult.status, error: chunk2FirstResult.error ?? null });
  if (chunk2FirstResult.status !== 'error')
    throw new Error(`chunk 2 original code was expected to error but did not: ${JSON.stringify(chunk2FirstResult)}`);
  if (!String(chunk2FirstResult.stderr ?? '').match(/bas|not found/i))
    throw new Error(`chunk 2 error did not surface the expected undefined-object message: ${JSON.stringify(chunk2FirstResult)}`);

  // --- Fix: write the corrected chunk back to the SOURCE FILE via
  // edit_document, targeting the actual open document, not a throwaway
  // string. ------------------------------------------------------------------
  const active = await toolCall('get_active_document_context', {});
  if (active.result.active !== true || typeof active.result.document_id !== 'string')
    throw new Error(`active editor context is not eligible for the write-back: ${JSON.stringify(active.result)}`);
  const documentId = active.result.document_id;
  const document = await toolCall('read_open_document', { document_id: documentId });
  if (!String(document.result.contents ?? '').includes(CHUNK_2_ORIGINAL))
    throw new Error('open document did not contain the original chunk before write-back');
  const editRequest = await toolCall('edit_document', {
    document_id: documentId,
    expected_text: CHUNK_2_ORIGINAL,
    replacement: CHUNK_2_FIXED,
  });
  stepLog.push({ step: 'edit_document', status: editRequest.result.status });

  const editDeadline = Date.now() + 60000;
  let appliedContents;
  while (Date.now() < editDeadline) {
    const updated = await toolCall('read_open_document', { document_id: documentId });
    if (String(updated.result.contents ?? '').includes(CHUNK_2_FIXED)) {
      appliedContents = updated.result.contents;
      break;
    }
    await sleep(250);
  }
  if (!appliedContents)
    throw new Error('timed out waiting for the fixed chunk 2 to apply to the open source buffer');

  // --- Retest: rerun the CORRECTED chunk 2 in the actual Console, proving
  // the fix is not just text in a buffer -- it genuinely re-executes and
  // succeeds. ------------------------------------------------------------------
  const chunk2RetestResult = await runAndAwait(CHUNK_2_FIXED);
  stepLog.push({ chunk: '2-fixed', status: chunk2RetestResult.status });
  if (chunk2RetestResult.status !== 'ok')
    throw new Error(`chunk 2 fixed code still failed on retest: ${JSON.stringify(chunk2RetestResult)}`);
  const chunk2Env = await toolCall('get_environment_summary', { object_names: ['rai_audit_scaled'] });
  const scaledEntry = chunk2Env.result.objects?.find((object) => object.name === 'rai_audit_scaled');
  if (!scaledEntry?.found)
    throw new Error(`fixed chunk 2 did not bind rai_audit_scaled: ${JSON.stringify(chunk2Env.result)}`);

  // --- Chunk 3: only proceeds NOW, after chunk 2 was genuinely fixed and
  // retested -- proving the audit loop gates forward progress on real
  // success, not on merely having attempted a fix. --------------------------
  const chunk3Result = await runAndAwait(CHUNK_3);
  stepLog.push({ chunk: 3, status: chunk3Result.status, stdout: chunk3Result.stdout ?? null });
  if (chunk3Result.status !== 'ok')
    throw new Error(`chunk 3 failed even after chunk 2 was fixed: ${JSON.stringify(chunk3Result)}`);
  if (!String(chunk3Result.stdout ?? '').includes(String(EXPECTED_TOTAL)))
    throw new Error(`chunk 3 did not produce the value that depends on the fixed chunk 2 (expected ${EXPECTED_TOTAL}): ${JSON.stringify(chunk3Result)}`);

  writeFileSync(`${stateDir}/multi-chunk-audit-data.json`, JSON.stringify({
    step_log: stepLog,
    chunk1_result: chunk1Result,
    chunk2_first_result: chunk2FirstResult,
    edit_document_id: documentId,
    applied_source_contents: appliedContents,
    chunk2_retest_result: chunk2RetestResult,
    chunk3_result: chunk3Result,
    transcript,
  }, null, 2));
  log('[fake-provider-multi-chunk-audit] data written');

  await sleep(30000);
}

main().catch((error) => {
  log(`[fake-provider-multi-chunk-audit] fatal: ${error.stack ?? error}`);
  writeFileSync(`${stateDir}/error.txt`, String(error?.stack ?? error));
  process.exitCode = 1;
}).finally(() => child.kill());
