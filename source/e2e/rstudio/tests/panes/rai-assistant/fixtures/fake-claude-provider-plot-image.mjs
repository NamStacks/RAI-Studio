#!/usr/bin/env node
// Deterministic, test-only Stage 2 MCP client. In "plot" mode it submits one
// approval-gated base-R plot proposal, waits for its stored Console result, then
// reads get_plot_image with no arguments. In "no-plot" mode it calls only
// get_plot_image so the raw rejection can prove it never reached the Console.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

export const PLOT_R_CODE = "{ plot(c(1, 4, 9, 16), type = 'b', pch = 19, col = 'steelblue', main = 'RAI_STAGE2_PLOT') }";
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function findArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configPath = findArg('--mcp-config');
const stateDir = findArg('--test-state-dir');
if (!configPath || !stateDir)
  throw new Error('plot-image provider requires --mcp-config and --test-state-dir');

mkdirSync(stateDir, { recursive: true });
writeFileSync(`${stateDir}/provider.pid`, String(process.pid));
const scenarioPath = `${stateDir}/scenario.json`;
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
if (!['plot', 'no-plot'].includes(scenario.mode))
  throw new Error('plot-image scenario mode must be plot or no-plot');

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
const deadline = () => Date.now() + 120000;

async function submitPlot(transcript) {
  const proposal = { language: 'R', target: 'console', code: PLOT_R_CODE };
  const response = await call('tools/call', { name: 'run_r', arguments: { proposal } });
  const result = textToolResult(response);
  transcript.push({ tool: 'run_r', arguments: { proposal }, response, result });
  const message = String(result.message ?? result.error ?? '');
  if (result.run_id || !/no approved effect contract/.test(message))
    throw new Error(`plot() must stay refused by the effect contract: ${JSON.stringify(result)}`);
  return { proposal, result };
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
  const transcript = [];
  transcript.push({ method: 'initialize', response: await call('initialize', { protocolVersion: '2024-11-05' }) });

  let plot;
  if (scenario.mode === 'plot')
    plot = await submitPlot(transcript);

  // Deliberately no arguments: this is a read-only image request, never a
  // second proposal or a Console command.
  const imageResponse = await call('tools/call', { name: 'get_plot_image', arguments: {} });
  transcript.push({ tool: 'get_plot_image', arguments: {}, response: imageResponse });

  const data = { mode: scenario.mode, plot, image_response: imageResponse, transcript };
  if (imageResponse.result?.content?.[0]?.type === 'image')
    data.image = imageMetadata(imageResponse);
  else
    data.image_error = imageResponse.error ?? textToolResult(imageResponse);
  writeFileSync(`${stateDir}/plot-image-data.json`, JSON.stringify(data, null, 2));
  log(`[fake-provider-plot-image] ${scenario.mode} data written`);

  // Keep the provider/Assistant iframe stable until fixture teardown.
  await sleep(90000);
}

main().catch((error) => {
  log(`[fake-provider-plot-image] fatal: ${error.stack ?? error}`);
  process.exitCode = 1;
}).finally(() => child.kill());
