#!/usr/bin/env node
// Regression guard for the .Rmd structures a real notebook actually contains,
// which fake-claude-provider-rmd-chunk-writeback.mjs deliberately leaves out.
// That fixture uses the simplest possible document: YAML, prose, and three
// uniquely-labeled chunks. Every anchor in it is unambiguous and every line is
// inert. A real notebook is not like that, and each of the following is a
// distinct way an audit edit can corrupt one:
//
//   (a) An INLINE r expression in prose (`r rai_nb_total`). It is live code
//       outside any fence, referencing a binding the chunks produce. An edit
//       that matched prose, or a fix that did not really fix, shows up as the
//       wrong rendered value here.
//   (b) A chunk carrying explicit OPTIONS ({r setup-labeled, echo=FALSE,
//       warning=FALSE}). The options live on the fence header line, which is
//       exactly the line an over-greedy replacement swallows. Losing
//       echo=FALSE silently changes the rendered document.
//   (c) TWO ANONYMOUS chunks ({r} with no label). R Markdown auto-numbers
//       these, so the document contains the identical header text twice and
//       there is no label to anchor against.
//   (d) YAML FRONTMATTER, which must survive untouched.
//
// OBSERVED NATIVE BEHAVIOR (recorded here rather than assumed; the source of
// truth is raiValidateAnchoredEdit in SessionRaiAssistant.cpp):
//
//   * Uniqueness is checked on expected_text ALONE, and BEFORE context is
//     considered. So the anonymous fence header can never anchor an edit: it
//     occurs twice, and the request is refused with "expected_text must occur
//     exactly once in the current open document" even when the supplied
//     context would have disambiguated it.
//   * context_before/context_after must match the text IMMEDIATELY around
//     expected_text. Borrowing another chunk's header as context is refused
//     with a context mismatch, so an edit meant for one chunk cannot land in
//     another.
//   * A correctly anchored edit inside an anonymous chunk changes the chunk
//     body and nothing else: the YAML block, the options header, the inline
//     expression, both anonymous headers, and every prose line come back
//     byte-identical, and the fence count is unchanged.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

// Assembled line-by-line rather than as one template literal: the fence marker
// is three backticks, which cannot appear unescaped inside a JS template.
const FENCE = '```';
export const YAML_LINES = [
  '---',
  'title: "RAI notebook edge cases"',
  'author: "RAI"',
  'output: html_document',
  '---',
];
// (b) The options must survive verbatim -- this exact header line is compared
// byte-for-byte before and after the edit.
export const OPTIONS_HEADER = `${FENCE}{r setup-labeled, echo=FALSE, warning=FALSE}`;
// (c) The identical header text for both unlabeled chunks.
export const ANON_HEADER = `${FENCE}{r}`;
// (a) Live code in prose, referencing what the chunks compute.
export const INLINE_EXPRESSION = '`r rai_nb_total`';

export const CHUNK_SETUP = 'rai_nb_base <- 6L';
export const CHUNK_ANON_ONE = 'rai_nb_factor <- 4L';
// BUGGY: `rai_nb_bse` is a typo for `rai_nb_base`, so this chunk errors and
// the inline expression above would render an error rather than a number.
export const CHUNK_ANON_TWO_ORIGINAL = 'rai_nb_total <- rai_nb_bse * rai_nb_factor';
export const CHUNK_ANON_TWO_FIXED = 'rai_nb_total <- rai_nb_base * rai_nb_factor';
// Only reachable once the second anonymous chunk is genuinely fixed and rerun.
const EXPECTED_TOTAL = 6 * 4;

// The anchors that pin the edit inside the SECOND anonymous chunk. The header
// is not unique, but the body is, and the context proves which fence it sits
// in.
export const CONTEXT_BEFORE = `${ANON_HEADER}\n`;
export const CONTEXT_AFTER = `\n${FENCE}`;

function rmdSource(anonTwoBody) {
  return [
    ...YAML_LINES,
    '',
    'Intro prose above every chunk. The audit edit must not touch this line.',
    '',
    `The computed total is ${INLINE_EXPRESSION} in the middle of this sentence.`,
    '',
    OPTIONS_HEADER,
    CHUNK_SETUP,
    FENCE,
    '',
    'Prose between the labeled chunk and the first anonymous chunk.',
    '',
    ANON_HEADER,
    CHUNK_ANON_ONE,
    FENCE,
    '',
    'Prose between the two anonymous chunks.',
    '',
    ANON_HEADER,
    anonTwoBody,
    FENCE,
    '',
    'Closing prose below the last chunk.',
    '',
  ].join('\n');
}

export const RMD_ORIGINAL = rmdSource(CHUNK_ANON_TWO_ORIGINAL);
export const RMD_FIXED = rmdSource(CHUNK_ANON_TWO_FIXED);

// Re-executes the two anonymous chunks from a cleared state, in document
// order, to prove they still run correctly after the edit.
// exists() has no approved effect contract, and an anonymous tryCatch handler
// is refused as an uninspectable higher-order argument. A missing binding
// makes try() return a try-error, which is not identical to the computed total.
export const CLEAR_CODE =
  "{ rm(list = c('rai_nb_factor', 'rai_nb_total')); " +
  "present <- identical(try(force(rai_nb_total), silent = TRUE), 24); " +
  "cat('RAI_NB_CLEARED', if (present) 'TRUE' else 'FALSE', '\\n') }";
// What the inline `r rai_nb_total` expression evaluates to at render time.
export const INLINE_PROBE_CODE = "{ cat('RAI_NB_INLINE', rai_nb_total, '\\n') }";
export const REORDER_PROBE_CODE =
  "{ cat('RAI_NB_REORDER', rai_nb_factor, rai_nb_total, '\\n') }";

function findArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configPath = findArg('--mcp-config');
const stateDir = findArg('--test-state-dir');
if (!configPath || !stateDir)
  throw new Error('rmd-notebook-edge-cases provider requires --mcp-config and --test-state-dir');

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

async function runAndAwait(code, timeoutMs = 60000) {
  const proposal = { language: 'R', target: 'console', code };
  const deadline = Date.now() + timeoutMs;
  let runId;
  while (Date.now() < deadline) {
    const run = await toolCall('run_r', { proposal });
    if (run.result.status === 'approval_required' || run.result.status === 'busy') {
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

function countOccurrences(text, needle) {
  return String(text ?? '').split(needle).length - 1;
}

// The exact structural landmarks compared before and after the edit. Anything
// an over-greedy replacement would damage is captured here as literal text.
function structureOf(contents) {
  const text = String(contents ?? '');
  const lines = text.split('\n');
  return {
    yaml_block: lines.slice(0, YAML_LINES.length).join('\n'),
    options_header_line: lines.find((line) => line.startsWith(`${FENCE}{r setup-labeled`)) ?? null,
    inline_expression_line: lines.find((line) => line.includes('`r ')) ?? null,
    fence_count: countOccurrences(text, FENCE),
    anonymous_header_count: countOccurrences(text, `${ANON_HEADER}\n`),
    total_lines: lines.length,
  };
}

async function main() {
  transcript.push({ method: 'initialize', response: await call('initialize', { protocolVersion: '2024-11-05' }) });
  const listed = await call('tools/list', {});
  const names = listed.result?.tools?.map((entry) => entry.name) ?? [];
  for (const required of ['run_r', 'get_run_result', 'get_environment_summary',
    'get_active_document_context', 'read_open_document', 'edit_document']) {
    if (!names.includes(required))
      throw new Error(`rmd-notebook-edge-cases workflow requires tool "${required}", got: ${JSON.stringify(names)}`);
  }

  const active = await toolCall('get_active_document_context', {});
  if (active.result.active !== true || typeof active.result.document_id !== 'string')
    throw new Error(`active editor context is not eligible for the write-back: ${JSON.stringify(active.result)}`);
  const documentId = active.result.document_id;
  const documentType = active.result.type ?? null;

  const originalDocument = await toolCall('read_open_document', { document_id: documentId });
  if (originalDocument.result.contents !== RMD_ORIGINAL)
    throw new Error(`open buffer is not the expected .Rmd source: ${JSON.stringify(originalDocument.result)}`);
  const structureBefore = structureOf(originalDocument.result.contents);
  if (structureBefore.anonymous_header_count !== 2)
    throw new Error(`the fixture document must contain two anonymous chunks: ${JSON.stringify(structureBefore)}`);

  // --- Top-down audit, chunk by chunk in document order. -------------------
  const setupResult = await runAndAwait(CHUNK_SETUP);
  stepLog.push({ chunk: 'setup-labeled', status: setupResult.status });
  if (setupResult.status !== 'ok')
    throw new Error(`the labeled setup chunk unexpectedly failed: ${JSON.stringify(setupResult)}`);

  const anonOneResult = await runAndAwait(CHUNK_ANON_ONE);
  stepLog.push({ chunk: 'anon-one', status: anonOneResult.status });
  if (anonOneResult.status !== 'ok')
    throw new Error(`the first anonymous chunk unexpectedly failed: ${JSON.stringify(anonOneResult)}`);

  const anonTwoFirstResult = await runAndAwait(CHUNK_ANON_TWO_ORIGINAL);
  stepLog.push({ chunk: 'anon-two-original', status: anonTwoFirstResult.status });
  if (anonTwoFirstResult.status !== 'error')
    throw new Error(`the buggy anonymous chunk was expected to error: ${JSON.stringify(anonTwoFirstResult)}`);
  if (!String(anonTwoFirstResult.stderr ?? '').match(/rai_nb_bse|not found/i))
    throw new Error(`the buggy chunk error did not name the typo: ${JSON.stringify(anonTwoFirstResult)}`);

  // --- Edge case (c), probe 1: the anonymous fence header cannot anchor an
  // edit, because it occurs twice. Uniqueness is judged on expected_text
  // alone and before context is even looked at, so supplying context does not
  // rescue it. --------------------------------------------------------------
  const ambiguousEdit = await toolCall('edit_document', {
    document_id: documentId,
    expected_text: ANON_HEADER,
    replacement: `${FENCE}{r renamed}`,
    context_before: '\n',
    context_after: '\n',
  });
  const ambiguousError = ambiguousEdit.response.error?.message ?? null;
  stepLog.push({ step: 'edit_document-ambiguous-header', status: ambiguousEdit.result.status ?? 'rejected' });
  if (!ambiguousError || !/exactly once/i.test(ambiguousError))
    throw new Error(`the duplicated anonymous header should have been refused as non-unique: ${JSON.stringify(ambiguousEdit)}`);

  // --- Edge case (c), probe 2: context must surround expected_text
  // IMMEDIATELY. Borrowing the labeled chunk's options header as context is a
  // mismatch, so an edit meant for one chunk cannot land in another. --------
  const wrongContextEdit = await toolCall('edit_document', {
    document_id: documentId,
    expected_text: CHUNK_ANON_TWO_ORIGINAL,
    replacement: CHUNK_ANON_TWO_FIXED,
    context_before: `${OPTIONS_HEADER}\n`,
    context_after: CONTEXT_AFTER,
  });
  const wrongContextError = wrongContextEdit.response.error?.message ?? null;
  stepLog.push({ step: 'edit_document-wrong-context', status: wrongContextEdit.result.status ?? 'rejected' });
  if (!wrongContextError || !/context_before|context_after/i.test(wrongContextError))
    throw new Error(`an edit anchored on another chunk's header should have been refused: ${JSON.stringify(wrongContextEdit)}`);

  const afterRefusals = await toolCall('read_open_document', { document_id: documentId });
  if (afterRefusals.result.contents !== RMD_ORIGINAL)
    throw new Error(`a refused edit mutated the buffer: ${JSON.stringify(afterRefusals.result)}`);

  // --- The real fix, anchored strictly inside the SECOND anonymous chunk. --
  const editRequest = await toolCall('edit_document', {
    document_id: documentId,
    expected_text: CHUNK_ANON_TWO_ORIGINAL,
    replacement: CHUNK_ANON_TWO_FIXED,
    context_before: CONTEXT_BEFORE,
    context_after: CONTEXT_AFTER,
  });
  stepLog.push({ step: 'edit_document', status: editRequest.result.status });

  const editDeadline = Date.now() + 60000;
  let appliedContents;
  while (Date.now() < editDeadline) {
    const updated = await toolCall('read_open_document', { document_id: documentId });
    if (String(updated.result.contents ?? '').includes(CHUNK_ANON_TWO_FIXED)) {
      appliedContents = updated.result.contents;
      break;
    }
    await sleep(250);
  }
  if (!appliedContents)
    throw new Error('timed out waiting for the fixed anonymous chunk to apply to the open .Rmd buffer');
  if (appliedContents !== RMD_FIXED)
    throw new Error(`the .Rmd edit changed more than the chunk body: ${JSON.stringify(appliedContents)}`);
  const structureAfter = structureOf(appliedContents);

  // --- Retest the corrected chunk in the real Console. --------------------
  const anonTwoRetestResult = await runAndAwait(CHUNK_ANON_TWO_FIXED);
  stepLog.push({ chunk: 'anon-two-fixed', status: anonTwoRetestResult.status });
  if (anonTwoRetestResult.status !== 'ok')
    throw new Error(`the fixed anonymous chunk still failed on retest: ${JSON.stringify(anonTwoRetestResult)}`);

  // --- Edge case (a): what the inline `r rai_nb_total` expression would
  // render, evaluated in the live Console. ---------------------------------
  const inlineResult = await runAndAwait(INLINE_PROBE_CODE);
  stepLog.push({ step: 'inline-expression', status: inlineResult.status });
  if (inlineResult.status !== 'ok')
    throw new Error(`the inline expression probe failed: ${JSON.stringify(inlineResult)}`);
  const inlineMatch = String(inlineResult.stdout ?? '').match(/RAI_NB_INLINE\s+(\S+)/);
  if (!inlineMatch)
    throw new Error(`could not read the inline expression probe output: ${JSON.stringify(inlineResult)}`);
  const inlineValue = inlineMatch[1];
  if (inlineValue !== String(EXPECTED_TOTAL))
    throw new Error(`the inline expression would render ${inlineValue}, expected ${EXPECTED_TOTAL}`);

  // --- Edge case (c), continued: both anonymous chunks still execute
  // correctly IN ORDER. Cleared first, so this re-execution genuinely
  // recomputes rather than reading what earlier steps left behind. ---------
  const clearResult = await runAndAwait(CLEAR_CODE);
  stepLog.push({ step: 'clear-anonymous-bindings', status: clearResult.status });
  if (clearResult.status !== 'ok' || !String(clearResult.stdout ?? '').includes('RAI_NB_CLEARED FALSE'))
    throw new Error(`clearing the anonymous chunk bindings failed: ${JSON.stringify(clearResult)}`);

  const anonOneRerun = await runAndAwait(CHUNK_ANON_ONE);
  stepLog.push({ chunk: 'anon-one-rerun', status: anonOneRerun.status });
  if (anonOneRerun.status !== 'ok')
    throw new Error(`the first anonymous chunk failed on re-execution: ${JSON.stringify(anonOneRerun)}`);

  const anonTwoRerun = await runAndAwait(CHUNK_ANON_TWO_FIXED);
  stepLog.push({ chunk: 'anon-two-rerun', status: anonTwoRerun.status });
  if (anonTwoRerun.status !== 'ok')
    throw new Error(`the second anonymous chunk failed on re-execution: ${JSON.stringify(anonTwoRerun)}`);

  const reorderResult = await runAndAwait(REORDER_PROBE_CODE);
  stepLog.push({ step: 'anonymous-order-probe', status: reorderResult.status });
  const reorderMatch = String(reorderResult.stdout ?? '').match(/RAI_NB_REORDER\s+(\S+)\s+(\S+)/);
  if (!reorderMatch)
    throw new Error(`could not read the ordered re-execution probe: ${JSON.stringify(reorderResult)}`);
  const orderedValues = { rai_nb_factor: reorderMatch[1], rai_nb_total: reorderMatch[2] };

  const environmentDetail = await toolCall('get_environment_summary', {
    object_names: ['rai_nb_base', 'rai_nb_factor', 'rai_nb_total'],
  });

  writeFileSync(`${stateDir}/rmd-edge-cases-data.json`, JSON.stringify({
    step_log: stepLog,
    document_id: documentId,
    document_type: documentType,
    original_contents: originalDocument.result.contents,
    structure_before: structureBefore,
    setup_result: setupResult,
    anon_one_result: anonOneResult,
    anon_two_first_result: anonTwoFirstResult,
    ambiguous_header_error: ambiguousError,
    wrong_context_error: wrongContextError,
    contents_after_refusals: afterRefusals.result.contents,
    applied_contents: appliedContents,
    structure_after: structureAfter,
    anon_two_retest_result: anonTwoRetestResult,
    inline_value: inlineValue,
    inline_stdout: inlineResult.stdout ?? null,
    clear_result: clearResult,
    anon_one_rerun: anonOneRerun,
    anon_two_rerun: anonTwoRerun,
    ordered_values: orderedValues,
    reorder_stdout: reorderResult.stdout ?? null,
    environment_detail: environmentDetail.result,
    transcript,
  }, null, 2));
  log('[fake-provider-rmd-notebook-edge-cases] data written');

  await sleep(30000);
}

main().catch((error) => {
  log(`[fake-provider-rmd-notebook-edge-cases] fatal: ${error.stack ?? error}`);
  writeFileSync(`${stateDir}/error.txt`, String(error?.stack ?? error));
  process.exitCode = 1;
}).finally(() => child.kill());

