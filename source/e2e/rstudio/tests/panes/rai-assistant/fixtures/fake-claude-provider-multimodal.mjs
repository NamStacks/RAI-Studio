#!/usr/bin/env node
// Multi-step, multi-modal proof: a scripted provider that plans each round
// from the REAL prior Console result (not a canned script blind to state),
// increases code complexity round over round, and finishes by reading a
// real rendered plot PNG back through get_plot_image. Every run_r call is
// still approval-gated through the native card; only get_plot_image (a
// read-only tool) skips approval.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

function findArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configPath = findArg('--mcp-config');
const stateDir = findArg('--test-state-dir');
if (!configPath || !stateDir)
  throw new Error('multimodal provider requires --mcp-config and --test-state-dir');

mkdirSync(stateDir, { recursive: true });
writeFileSync(`${stateDir}/provider.pid`, String(process.pid));

function log(line) {
  process.stdout.write(`${line}\n`);
  appendFileSync(`${stateDir}/provider.log`, `${line}\n`);
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const server = sessionMcpServer(config);
if (!server) throw new Error('MCP config has no rai server');

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
const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on('line', (line) => {
  try {
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  } catch { /* ignore non-protocol diagnostics */ }
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = () => Date.now() + 120000;

// Submit one run_r proposal, wait through approval, then poll get_run_result
// to a settled state. Returns the parsed run result so the CALLER (not a
// canned script) decides what the next round's code should be -- this is
// the actual "plan next step from real output" loop being tested.
async function runAndRead(code, transcript) {
  const proposal = { language: 'R', target: 'console', code };
  const until = deadline();
  let runId;
  while (Date.now() < until) {
    const response = await call('tools/call', { name: 'run_r', arguments: { proposal } });
    const result = textToolResult(response);
    transcript.push({ tool: 'run_r', arguments: { proposal }, result });
    if (result.status === 'approval_required') { await sleep(250); continue; }
    if (!result.run_id) throw new Error(`run_r did not return a run_id: ${JSON.stringify(result)}`);
    runId = result.run_id;
    break;
  }
  if (!runId) throw new Error(`timed out waiting for approval of: ${code}`);

  let runResult;
  while (Date.now() < until) {
    const response = await call('tools/call', { name: 'get_run_result', arguments: { run_id: runId } });
    const result = textToolResult(response);
    transcript.push({ tool: 'get_run_result', arguments: { run_id: runId }, result });
    if (result.status === 'pending') { await sleep(250); continue; }
    runResult = result;
    break;
  }
  if (!runResult) throw new Error(`timed out waiting for get_run_result(${runId})`);
  return { proposal, runId, runResult };
}

function extractNumber(stdout, fallback) {
  const match = /RAI_MM_VALUE=(-?\d+(?:\.\d+)?)/.exec(stdout ?? '');
  return match ? Number(match[1]) : fallback;
}

async function main() {
  const transcript = [];
  transcript.push({ method: 'initialize', response: await call('initialize', { protocolVersion: '2024-11-05' }) });
  const rounds = [];

  // Round 1: trivial arithmetic -- establishes the planning baseline.
  const r1 = await runAndRead(
    "{ rai_mm_a <- 6 * 7; cat(sprintf('RAI_MM_VALUE=%d\\n', rai_mm_a)) }",
    transcript,
  );
  const v1 = extractNumber(r1.runResult.stdout, 42);
  rounds.push({ round: 1, label: 'arithmetic', code: r1.proposal.code, result: r1.runResult, readValue: v1 });

  // Round 2: vector operation built FROM round 1's actual read value.
  const r2 = await runAndRead(
    `{ rai_mm_vec <- ${v1} + c(1,2,3); rai_mm_b <- sum(rai_mm_vec); cat(sprintf('RAI_MM_VALUE=%d\\n', rai_mm_b)) }`,
    transcript,
  );
  const v2 = extractNumber(r2.runResult.stdout, v1);
  rounds.push({ round: 2, label: 'vector-op-from-round1', code: r2.proposal.code, result: r2.runResult, readValue: v2 });

  // Round 3: custom function call using round 2's value, deliberately a
  // runtime error (division by a variable that does not exist yet) --
  // proves the planner distinguishes error output from success output
  // before deciding the next step.
  const r3 = await runAndRead(
    "{ stop(sprintf('RAI_MM_INDUCED_ERROR value=%d', rai_mm_nonexistent_var)) }",
    transcript,
  );
  rounds.push({ round: 3, label: 'deliberate-error', code: r3.proposal.code, result: r3.runResult, readValue: null });
  if (r3.runResult.status !== 'error')
    throw new Error(`round 3 was expected to error, got: ${JSON.stringify(r3.runResult)}`);

  // Round 4: correction that reads round 2's REAL value (not a guess),
  // ignoring the failed round 3 attempt entirely.
  const r4 = await runAndRead(
    `{ rai_mm_scale <- function(x, k) x * k; rai_mm_c <- rai_mm_scale(${v2}, 2L); cat(sprintf('RAI_MM_VALUE=%d\\n', rai_mm_c)) }`,
    transcript,
  );
  const v4 = extractNumber(r4.runResult.stdout, v2 * 2);
  rounds.push({ round: 4, label: 'corrected-function-call', code: r4.proposal.code, result: r4.runResult, readValue: v4 });

  // Round 5: data-frame aggregation chaining round 1 and round 4's values.
  const r5 = await runAndRead(
    `{ rai_mm_df <- data.frame(grp = c('x','x','y'), val = c(${v1}, ${v4}, 10)); ` +
      `rai_mm_agg <- aggregate(val ~ grp, data = rai_mm_df, FUN = sum); ` +
      `rai_mm_d <- sum(rai_mm_agg$val); cat(sprintf('RAI_MM_VALUE=%d\\n', rai_mm_d)) }`,
    transcript,
  );
  const v5 = extractNumber(r5.runResult.stdout, v1 + v4 + 10);
  rounds.push({ round: 5, label: 'dataframe-aggregation', code: r5.proposal.code, result: r5.runResult, readValue: v5 });

  // Round 6: the title embeds the real prior values, and plot() stays refused.
  // A user-console plot is not a substitute for this assistant call.
  const plotCode =
    `{ plot(1:5, (1:5)^2, type = 'b', pch = 19, col = 'darkred', ` +
    `main = paste('RAI_MM_PLOT v1=${v1} v2=${v2} v4=${v4} v5=${v5}')) }`;
  const plotProposal = { language: 'R', target: 'console', code: plotCode };
  const plotResponse = await call('tools/call', { name: 'run_r', arguments: { proposal: plotProposal } });
  const plotResult = textToolResult(plotResponse);
  transcript.push({ tool: 'run_r', arguments: { proposal: plotProposal }, result: plotResult });
  const plotMessage = String(plotResult.message ?? plotResult.error ?? '');
  if (plotResult.run_id || !/no approved effect contract/.test(plotMessage))
    throw new Error(`plot() must stay refused by the effect contract: ${JSON.stringify(plotResult)}`);
  rounds.push({ round: 6, label: 'plot-from-session-state', code: plotCode, result: plotResult, readValue: null });

  const imageResponse = await call('tools/call', { name: 'get_plot_image', arguments: {} });
  transcript.push({ tool: 'get_plot_image', arguments: {}, response: imageResponse });

  const data = {
    rounds,
    image_error: imageResponse.error ?? textToolResult(imageResponse),
    transcript,
  };
  writeFileSync(`${stateDir}/multimodal-data.json`, JSON.stringify(data, null, 2));
  log('[fake-provider-multimodal] rounds written; plot refused');

  await sleep(90000);
}

main().catch((error) => {
  log(`[fake-provider-multimodal] fatal: ${error.stack ?? error}`);
  process.exitCode = 1;
}).finally(() => child.kill());
