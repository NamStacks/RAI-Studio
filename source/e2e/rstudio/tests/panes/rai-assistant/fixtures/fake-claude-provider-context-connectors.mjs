#!/usr/bin/env node
// Deterministic, test-only MCP client for the read-only context connectors:
// get_project_context, get_environment_summary (listing and named detail),
// get_plot_history, and get_plot_image with a history index.
//
// It makes ONLY read-only calls. There is no run_r proposal, no approval, and
// no editor tool, so every piece of state it observes -- project files, the
// .GlobalEnv objects, the plot history -- was established entirely by the
// Playwright test's own non-MCP harness before this provider ever launches.
// That is what makes the assertions on the other side meaningful: the
// connectors are reading the real IDE, not something they created.
import { createHash } from 'node:crypto';
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
  throw new Error('context-connectors provider requires --mcp-config and --test-state-dir');

mkdirSync(stateDir, { recursive: true });
writeFileSync(`${stateDir}/provider.pid`, String(process.pid));
const scenario = JSON.parse(readFileSync(`${stateDir}/scenario.json`, 'utf8'));
if (!Array.isArray(scenario.object_names) || scenario.object_names.length < 1)
  throw new Error('context-connectors scenario requires object_names');

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

async function readOnlyCall(tool, args) {
  const response = await call('tools/call', { name: tool, arguments: args });
  const result = textToolResult(response);
  transcript.push({ tool, arguments: args, response, result });
  return { response, result };
}

// An MCP image result carries the PNG inline, so record only its shape and
// digest -- the test re-derives both from the same base64 payload.
function imageMetadata(response) {
  const image = response.result?.content?.[0];
  if (!image || image.type !== 'image' || image.mimeType !== 'image/png' || typeof image.data !== 'string')
    return undefined;
  const bytes = Buffer.from(image.data, 'base64');
  return {
    type: image.type,
    mimeType: image.mimeType,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    signature: [...bytes.subarray(0, PNG_SIGNATURE.length)],
  };
}

async function plotImageAt(index) {
  const args = index === undefined ? {} : { index };
  const response = await call('tools/call', { name: 'get_plot_image', arguments: args });
  transcript.push({ tool: 'get_plot_image', arguments: args, response });
  return { response, image: imageMetadata(response), error: response.error };
}

async function main() {
  transcript.push({ method: 'initialize', response: await call('initialize', { protocolVersion: '2024-11-05' }) });

  // 1. Project context: no arguments at all, so this cannot be aimed anywhere
  //    but the session's own already-open project.
  const project = await readOnlyCall('get_project_context', {});

  // 2. Environment listing, then named detail for objects the test seeded
  //    through its own Console helper.
  const environmentListing = await readOnlyCall('get_environment_summary', {});
  const environmentDetail = await readOnlyCall('get_environment_summary', {
    object_names: scenario.object_names,
  });

  // 3. Plot history, then the image at whichever index it reports as active.
  //    The index is taken from the connector's own answer rather than being
  //    hard-coded, so the two tools have to agree for this to work at all.
  const plotHistory = await readOnlyCall('get_plot_history', {});
  const activeIndex = plotHistory.result?.active_index;
  const plots = Array.isArray(plotHistory.result?.plots) ? plotHistory.result.plots : [];

  const indexedImage = typeof activeIndex === 'number'
    ? await plotImageAt(activeIndex)
    : undefined;

  // Every reported index is probed, so the test can check that the
  // history's own `rendered` flag actually predicts what get_plot_image does.
  const perIndex = [];
  for (const entry of plots) {
    const attempt = await plotImageAt(entry.index);
    perIndex.push({
      index: entry.index,
      rendered: entry.rendered,
      ok: Boolean(attempt.image),
      error_message: attempt.error?.message,
    });
  }

  // An index past the end of the live history is the native boundary's call.
  const outOfRange = await plotImageAt(plots.length + 7);

  writeFileSync(`${stateDir}/context-connectors-data.json`, JSON.stringify({
    project_response: project.response,
    project_result: project.result,
    environment_listing: environmentListing.result,
    environment_listing_response: environmentListing.response,
    environment_detail: environmentDetail.result,
    environment_detail_response: environmentDetail.response,
    plot_history: plotHistory.result,
    indexed_image: indexedImage?.image,
    indexed_image_index: activeIndex,
    per_index: perIndex,
    out_of_range_error: outOfRange.error,
    transcript,
  }, null, 2));
  log('[fake-provider-context-connectors] data written');

  // Keep the provider/Assistant iframe stable until fixture teardown.
  await sleep(90000);
}

main().catch((error) => {
  log(`[fake-provider-context-connectors] fatal: ${error.stack ?? error}`);
  process.exitCode = 1;
}).finally(() => child.kill());
