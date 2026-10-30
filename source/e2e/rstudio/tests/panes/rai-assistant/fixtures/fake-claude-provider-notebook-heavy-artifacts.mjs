#!/usr/bin/env node
// Deterministic, test-only MCP client for the heavy Notebook/.Rmd IDE
// artifacts workflow. Every chunk in the target Notebook was already run
// through the real Source-pane chunk-execution path by the Playwright test
// BEFORE this provider ever launches -- this provider makes ZERO run_r/
// get_run_result/edit_document calls. It exists solely to prove the bounded,
// read-only RAI MCP connectors report exactly what the live IDE state
// already shows: a large data.frame's schema only (never rows/cell values),
// the plot history built from two heavy base plots plus an indexed PNG
// read for each rendered entry, and the Viewer widget's bounded
// active/kind/transport summary.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function findArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configPath = findArg('--mcp-config');
const stateDir = findArg('--test-state-dir');
if (!configPath || !stateDir)
  throw new Error('notebook-heavy-artifacts provider requires --mcp-config and --test-state-dir');

mkdirSync(stateDir, { recursive: true });
writeFileSync(`${stateDir}/provider.pid`, String(process.pid));

const scenarioPath = `${stateDir}/scenario.json`;
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
const tableVar = scenario.table_var;
if (!tableVar)
  throw new Error('notebook-heavy-artifacts scenario requires table_var');

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

function imageMetadata(response) {
  const image = response.result?.content?.[0];
  if (!image || image.type !== 'image' || image.mimeType !== 'image/png' || typeof image.data !== 'string')
    throw new Error(`get_plot_image did not return MCP PNG image content: ${JSON.stringify(response)}`);
  const bytes = Buffer.from(image.data, 'base64');
  return {
    type: image.type,
    mimeType: image.mimeType,
    byteLength: bytes.byteLength,
    signature: [...bytes.subarray(0, PNG_SIGNATURE.length)],
  };
}

async function main() {
  transcript.push({ method: 'initialize', response: await call('initialize', { protocolVersion: '2024-11-05' }) });
  const listed = await call('tools/list', {});
  const names = listed.result?.tools?.map((entry) => entry.name) ?? [];
  for (const required of ['get_environment_summary', 'get_plot_history', 'get_plot_image', 'get_viewer_state']) {
    if (!names.includes(required))
      throw new Error(`notebook-heavy-artifacts workflow requires tool "${required}", got: ${JSON.stringify(names)}`);
  }

  // 1. Environment schema only -- named detail for the table the notebook's
  // bigtable chunk already created. No listing call is needed for this
  // scenario, but the detail call itself is bounded to class/dims/columns.
  const environmentDetail = await toolCall('get_environment_summary', { object_names: [tableVar] });

  // 2. Plot history built from the two base plots the notebook's plots
  // chunk already rendered.
  const plotHistory = await toolCall('get_plot_history', {});
  const history = plotHistory.result;
  if (!history?.count || history.count < 2)
    throw new Error(`expected at least 2 plot history entries from the notebook's plots chunk: ${JSON.stringify(history)}`);

  // 3. Indexed PNG read for every already-rendered history entry -- purely
  // read-only, no plot() proposal, no active-index mutation.
  const plotImages = [];
  for (const entry of history.plots ?? []) {
    if (!entry.rendered) continue;
    const imageResponse = await call('tools/call', { name: 'get_plot_image', arguments: { index: entry.index } });
    transcript.push({ tool: 'get_plot_image', arguments: { index: entry.index }, response: imageResponse });
    plotImages.push({ index: entry.index, image: imageMetadata(imageResponse) });
  }
  if (plotImages.length === 0)
    throw new Error(`no rendered plot history entries were readable: ${JSON.stringify(history)}`);

  // 4. Viewer state: bounded active/kind/transport summary only, for the
  // Viewer widget the notebook's widget chunk already established.
  const viewer = await toolCall('get_viewer_state', {});

  writeFileSync(`${stateDir}/notebook-heavy-artifacts-data.json`, JSON.stringify({
    environment_detail: environmentDetail.result,
    environment_detail_response: environmentDetail.response,
    environment_listing_response: {},
    plot_history: history,
    plot_history_response: plotHistory.response,
    plot_images: plotImages,
    viewer_result: viewer.result,
    viewer_response: viewer.response,
    transcript,
  }, null, 2));
  log('[fake-provider-notebook-heavy-artifacts] data written');

  // Keep the provider/Assistant iframe stable until fixture teardown.
  await sleep(90000);
}

main().catch((error) => {
  log(`[fake-provider-notebook-heavy-artifacts] fatal: ${error.stack ?? error}`);
  writeFileSync(`${stateDir}/error.txt`, String(error?.stack ?? error));
  process.exitCode = 1;
}).finally(() => child.kill());
