#!/usr/bin/env node
// Regression guard for the audit write-back path against an .Rmd document
// rather than a plain .R script. The multi-chunk-audit fixture proves the
// run -> fail -> fix -> retest -> continue loop, but only on a .R file, where
// there are no fences, no prose, and edit_document's context anchors are
// optional. An .Rmd is the format the "audit my notebook chunk by chunk"
// request actually arrives in, and it is where the edit can go wrong in ways
// a .R file cannot: swallowing a fence marker, or matching prose outside the
// chunk.
//
// This exercises the .Rmd-specific half of the contract:
//   * context_before/context_after are REQUIRED for an .Rmd edit -- attempted
//     without them first, so the rejection is observed rather than assumed
//     (SessionRaiAssistant.cpp raiDocumentEditRequiresContext).
//   * The anchored edit lands strictly INSIDE the ```{r compute} fence: every
//     fence marker, the YAML header, and all three prose paragraphs come back
//     byte-identical.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

// Assembled line-by-line rather than as one template literal: the fence marker
// is three backticks, which cannot appear unescaped inside a JS template.
const FENCE = '```';
export const CHUNK_SETUP = 'rai_rmd_base <- 5L';
// BUGGY: `rai_rmd_bse` is a typo for `rai_rmd_base`, so this chunk errors.
export const CHUNK_COMPUTE_ORIGINAL = 'rai_rmd_total <- rai_rmd_bse * 4L';
export const CHUNK_COMPUTE_FIXED = 'rai_rmd_total <- rai_rmd_base * 4L';
export const CHUNK_REPORT = 'print(rai_rmd_total)';
// Only reachable once the compute chunk is genuinely fixed and rerun.
const EXPECTED_TOTAL = 5 * 4;

// The literal text on either side of the compute chunk's body. These are the
// .Rmd anchors: they pin the edit inside the fence, so a replacement can never
// silently consume the fence line itself.
export const CONTEXT_BEFORE = `${FENCE}{r compute}\n`;
export const CONTEXT_AFTER = `\n${FENCE}`;

function rmdSource(computeBody) {
  return [
    '---',
    'title: "RAI Rmd audit"',
    '---',
    '',
    'Prose above the setup chunk. The audit edit must not touch this line.',
    '',
    `${FENCE}{r setup}`,
    CHUNK_SETUP,
    FENCE,
    '',
    'Prose between the chunks. The audit edit must not touch this line either.',
    '',
    `${FENCE}{r compute}`,
    computeBody,
    FENCE,
    '',
    'Prose below the compute chunk, ahead of the report chunk.',
    '',
    `${FENCE}{r report}`,
    CHUNK_REPORT,
    FENCE,
    '',
  ].join('\n');
}

export const RMD_ORIGINAL = rmdSource(CHUNK_COMPUTE_ORIGINAL);
export const RMD_FIXED = rmdSource(CHUNK_COMPUTE_FIXED);

function findArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configPath = findArg('--mcp-config');
const stateDir = findArg('--test-state-dir');
if (!configPath || !stateDir)
  throw new Error('rmd-chunk-writeback provider requires --mcp-config and --test-state-dir');

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

function countFences(text) {
  return String(text ?? '').split(FENCE).length - 1;
}

async function main() {
  transcript.push({ method: 'initialize', response: await call('initialize', { protocolVersion: '2024-11-05' }) });
  const listed = await call('tools/list', {});
  const names = listed.result?.tools?.map((entry) => entry.name) ?? [];
  for (const required of ['run_r', 'get_run_result', 'get_environment_summary',
    'get_active_document_context', 'read_open_document', 'edit_document']) {
    if (!names.includes(required))
      throw new Error(`rmd-chunk-writeback workflow requires tool "${required}", got: ${JSON.stringify(names)}`);
  }

  const active = await toolCall('get_active_document_context', {});
  if (active.result.active !== true || typeof active.result.document_id !== 'string')
    throw new Error(`active editor context is not eligible for the write-back: ${JSON.stringify(active.result)}`);
  const documentId = active.result.document_id;
  const documentType = active.result.type ?? null;

  const originalDocument = await toolCall('read_open_document', { document_id: documentId });
  if (originalDocument.result.contents !== RMD_ORIGINAL)
    throw new Error(`open buffer is not the expected .Rmd source: ${JSON.stringify(originalDocument.result)}`);
  const fencesBefore = countFences(originalDocument.result.contents);

  // --- Chunk 1 (setup): runs clean. ----------------------------------------
  const setupResult = await runAndAwait(CHUNK_SETUP);
  stepLog.push({ chunk: 'setup', status: setupResult.status });
  if (setupResult.status !== 'ok')
    throw new Error(`setup chunk unexpectedly failed: ${JSON.stringify(setupResult)}`);

  // --- Chunk 2 (compute): genuinely errors on the typo, observed first. -----
  const computeFirstResult = await runAndAwait(CHUNK_COMPUTE_ORIGINAL);
  stepLog.push({ chunk: 'compute-original', status: computeFirstResult.status });
  if (computeFirstResult.status !== 'error')
    throw new Error(`compute chunk was expected to error but did not: ${JSON.stringify(computeFirstResult)}`);
  if (!String(computeFirstResult.stderr ?? '').match(/rai_rmd_bse|not found/i))
    throw new Error(`compute chunk error did not name the typo: ${JSON.stringify(computeFirstResult)}`);

  // --- .Rmd boundary: the same edit WITHOUT the fence anchors must be
  // refused. Observed, not assumed -- this is what keeps an .Rmd edit from
  // being anchored as loosely as a .R one. ----------------------------------
  const unanchoredEdit = await toolCall('edit_document', {
    document_id: documentId,
    expected_text: CHUNK_COMPUTE_ORIGINAL,
    replacement: CHUNK_COMPUTE_FIXED,
  });
  stepLog.push({ step: 'edit_document-unanchored', status: unanchoredEdit.result.status ?? 'rejected' });
  const unanchoredError = unanchoredEdit.response.error?.message ?? null;
  if (!unanchoredError || !/context_before|context_after/i.test(unanchoredError))
    throw new Error(`an .Rmd edit without fence anchors should have been refused: ${JSON.stringify(unanchoredEdit)}`);
  const afterRefusal = await toolCall('read_open_document', { document_id: documentId });
  if (afterRefusal.result.contents !== RMD_ORIGINAL)
    throw new Error(`the refused edit still mutated the buffer: ${JSON.stringify(afterRefusal.result)}`);

  // --- The real fix: anchored strictly inside the ```{r compute} fence. ----
  const editRequest = await toolCall('edit_document', {
    document_id: documentId,
    expected_text: CHUNK_COMPUTE_ORIGINAL,
    replacement: CHUNK_COMPUTE_FIXED,
    context_before: CONTEXT_BEFORE,
    context_after: CONTEXT_AFTER,
  });
  stepLog.push({ step: 'edit_document', status: editRequest.result.status });

  const editDeadline = Date.now() + 60000;
  let appliedContents;
  while (Date.now() < editDeadline) {
    const updated = await toolCall('read_open_document', { document_id: documentId });
    if (String(updated.result.contents ?? '').includes(CHUNK_COMPUTE_FIXED)) {
      appliedContents = updated.result.contents;
      break;
    }
    await sleep(250);
  }
  if (!appliedContents)
    throw new Error('timed out waiting for the fixed compute chunk to apply to the open .Rmd buffer');
  if (appliedContents !== RMD_FIXED)
    throw new Error(`the .Rmd edit changed more than the chunk body: ${JSON.stringify(appliedContents)}`);
  const fencesAfter = countFences(appliedContents);
  if (fencesAfter !== fencesBefore)
    throw new Error(`the edit changed the fence count (${fencesBefore} -> ${fencesAfter})`);

  // --- Retest the corrected chunk in the real Console, then run the report
  // chunk that depends on it. -----------------------------------------------
  const computeRetestResult = await runAndAwait(CHUNK_COMPUTE_FIXED);
  stepLog.push({ chunk: 'compute-fixed', status: computeRetestResult.status });
  if (computeRetestResult.status !== 'ok')
    throw new Error(`fixed compute chunk still failed on retest: ${JSON.stringify(computeRetestResult)}`);

  const reportResult = await runAndAwait(CHUNK_REPORT);
  stepLog.push({ chunk: 'report', status: reportResult.status, stdout: reportResult.stdout ?? null });
  if (reportResult.status !== 'ok')
    throw new Error(`report chunk failed after the fix: ${JSON.stringify(reportResult)}`);
  if (!String(reportResult.stdout ?? '').includes(String(EXPECTED_TOTAL)))
    throw new Error(`report chunk did not print ${EXPECTED_TOTAL}: ${JSON.stringify(reportResult)}`);

  const environmentDetail = await toolCall('get_environment_summary', { object_names: ['rai_rmd_total'] });

  writeFileSync(`${stateDir}/rmd-writeback-data.json`, JSON.stringify({
    step_log: stepLog,
    document_id: documentId,
    document_type: documentType,
    original_contents: originalDocument.result.contents,
    fences_before: fencesBefore,
    setup_result: setupResult,
    compute_first_result: computeFirstResult,
    unanchored_edit_error: unanchoredError,
    contents_after_refusal: afterRefusal.result.contents,
    applied_contents: appliedContents,
    fences_after: fencesAfter,
    compute_retest_result: computeRetestResult,
    report_result: reportResult,
    environment_detail: environmentDetail.result,
    transcript,
  }, null, 2));
  log('[fake-provider-rmd-chunk-writeback] data written');

  await sleep(30000);
}

main().catch((error) => {
  log(`[fake-provider-rmd-chunk-writeback] fatal: ${error.stack ?? error}`);
  writeFileSync(`${stateDir}/error.txt`, String(error?.stack ?? error));
  process.exitCode = 1;
}).finally(() => child.kill());
