#!/usr/bin/env node
// Regression guard for the "no new figure" half of the figure-inspection
// protocol. The existing plot fixtures (plot-image, slow-run-recovery) only
// cover a chunk that DOES draw: they prove a fresh plot is fetchable. Neither
// covers the far more common audit step -- a chunk that draws nothing -- and
// that is precisely where the protocol can silently lie, because
// get_plot_image with no index always returns whatever is currently ACTIVE.
// After a pure-computation chunk, that is still the previous chunk's figure.
//
// So the contract under test is: absence of a new figure is established by
// comparing get_plot_history across the run, NOT by calling get_plot_image
// and seeing whether bytes come back. This fixture proves both halves:
//
//   * get_plot_history is byte-for-byte unchanged across the no-plot chunk
//     (same count, same active_index, same per-index rendered flags), which
//     is the only sound "no new figure" signal.
//   * get_plot_image, called after the same no-plot chunk, returns the
//     EXACT SAME PNG as before it -- hashed here to prove identity, not
//     merely similarity. A client reporting that image as the chunk's output
//     would be reporting a stale figure from an earlier chunk.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

export const PLOT_CODE = "{ plot(1:5, main = 'RAI_PLOT_ABSENCE_FIRST') }";
export const NO_PLOT_CODE =
  '{ rai_plot_absence_value <- sum(1:10); print(rai_plot_absence_value) }';

function findArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configPath = findArg('--mcp-config');
const stateDir = findArg('--test-state-dir');
if (!configPath || !stateDir)
  throw new Error('plot-absence-audit provider requires --mcp-config and --test-state-dir');

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

async function plotHistory(label) {
  const history = await toolCall('get_plot_history', {});
  stepLog.push({ step: `get_plot_history:${label}`, count: history.result.count ?? null,
    active_index: history.result.active_index ?? null });
  return history.result;
}

// Returns the active plot's PNG digest, or null when the tool refuses because
// there is no active plot at all (that refusal is an MCP-level error, not a
// tool result).
async function activePlotDigest(label) {
  const response = await call('tools/call', { name: 'get_plot_image', arguments: {} });
  transcript.push({ tool: 'get_plot_image', arguments: {}, label, response });
  const image = response.result?.content?.[0];
  if (!image || image.type !== 'image' || image.mimeType !== 'image/png') {
    stepLog.push({ step: `get_plot_image:${label}`, digest: null,
      error: response.error?.message ?? 'no image returned' });
    return { digest: null, bytes: 0, error: response.error?.message ?? 'no image returned' };
  }
  const buffer = Buffer.from(image.data, 'base64');
  const digest = createHash('sha256').update(buffer).digest('hex');
  stepLog.push({ step: `get_plot_image:${label}`, digest, bytes: buffer.length });
  return { digest, bytes: buffer.length, error: null };
}

async function main() {
  transcript.push({ method: 'initialize', response: await call('initialize', { protocolVersion: '2024-11-05' }) });
  const listed = await call('tools/list', {});
  const names = listed.result?.tools?.map((entry) => entry.name) ?? [];
  for (const required of ['run_r', 'get_run_result', 'get_plot_history', 'get_plot_image', 'get_environment_summary']) {
    if (!names.includes(required))
      throw new Error(`plot-absence workflow requires tool "${required}", got: ${JSON.stringify(names)}`);
  }

  // --- Baseline. Deliberately NOT required to be empty: rstudioPage is
  // worker-scoped, so one RStudio serves every spec in a full-suite run, and
  // this history is only empty here because opening the scenario project
  // recycles R. The contract under test is a DELTA across two chunks, so
  // everything below is measured against this baseline rather than against
  // an assumption about how many figures the session has already drawn. -----
  const historyBaseline = await plotHistory('baseline');

  // plot() has no autonomous effect contract. The test draws the baseline
  // figure from the Console, then this provider only runs the no-plot chunk.
  writeFileSync(`${stateDir}/awaiting-user-plot`, '1');
  const plotDeadline = Date.now() + 60000;
  while (!existsSync(`${stateDir}/user-plot-ready`) && Date.now() < plotDeadline)
    await sleep(200);
  if (!existsSync(`${stateDir}/user-plot-ready`))
    throw new Error('timed out waiting for the Console baseline plot');
  const plotRun = { status: 'ok', source: 'user-console' };
  const historyAfterPlot = await plotHistory('after-plot');
  if (historyAfterPlot.count !== historyBaseline.count + 1)
    throw new Error(
      `the plotting chunk did not add exactly one figure ` +
      `(${historyBaseline.count} -> ${historyAfterPlot.count}): ${JSON.stringify(historyAfterPlot)}`);
  if (historyAfterPlot.active_index !== historyAfterPlot.count - 1)
    throw new Error(`the new figure did not become the active one: ${JSON.stringify(historyAfterPlot)}`);
  const digestAfterPlot = await activePlotDigest('after-plot');
  if (!digestAfterPlot.digest)
    throw new Error(`could not read the figure the plotting chunk drew: ${JSON.stringify(digestAfterPlot)}`);

  // --- Chunk 2 draws NOTHING: pure computation, no plot call. --------------
  const noPlotRun = await runAndAwait(NO_PLOT_CODE);
  stepLog.push({ chunk: 'no-plot', status: noPlotRun.status, stdout: noPlotRun.stdout ?? null });
  if (noPlotRun.status !== 'ok')
    throw new Error(`the no-plot chunk failed: ${JSON.stringify(noPlotRun)}`);
  if (!String(noPlotRun.stdout ?? '').includes('55'))
    throw new Error(`the no-plot chunk did not compute its value: ${JSON.stringify(noPlotRun)}`);

  // --- The sound signal: history is unchanged, so there is no new figure. --
  const historyAfterNoPlot = await plotHistory('after-no-plot');

  // --- The trap: the active image is still chunk 1's figure, byte-identical.
  // Reporting it as chunk 2's output would be reporting a stale figure. -----
  const digestAfterNoPlot = await activePlotDigest('after-no-plot');
  if (!digestAfterNoPlot.digest)
    throw new Error(`get_plot_image unexpectedly had nothing to return: ${JSON.stringify(digestAfterNoPlot)}`);

  const historyUnchanged =
    JSON.stringify(historyAfterNoPlot) === JSON.stringify(historyAfterPlot);
  if (!historyUnchanged)
    throw new Error(
      `a chunk that drew nothing still changed the plot history: ` +
      `${JSON.stringify(historyAfterPlot)} -> ${JSON.stringify(historyAfterNoPlot)}`);
  if (digestAfterNoPlot.digest !== digestAfterPlot.digest)
    throw new Error(
      `the active plot image changed across a chunk that drew nothing: ` +
      `${digestAfterPlot.digest} -> ${digestAfterNoPlot.digest}`);

  const environmentDetail = await toolCall('get_environment_summary', { object_names: ['rai_plot_absence_value'] });

  writeFileSync(`${stateDir}/plot-absence-data.json`, JSON.stringify({
    step_log: stepLog,
    history_baseline: historyBaseline,
    plot_run: plotRun,
    history_after_plot: historyAfterPlot,
    digest_after_plot: digestAfterPlot,
    no_plot_run: noPlotRun,
    history_after_no_plot: historyAfterNoPlot,
    digest_after_no_plot: digestAfterNoPlot,
    history_unchanged: historyUnchanged,
    active_image_is_stale: digestAfterNoPlot.digest === digestAfterPlot.digest,
    environment_detail: environmentDetail.result,
    transcript,
  }, null, 2));
  log('[fake-provider-plot-absence-audit] data written');

  await sleep(30000);
}

main().catch((error) => {
  log(`[fake-provider-plot-absence-audit] fatal: ${error.stack ?? error}`);
  writeFileSync(`${stateDir}/error.txt`, String(error?.stack ?? error));
  process.exitCode = 1;
}).finally(() => child.kill());
