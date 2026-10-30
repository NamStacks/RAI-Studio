#!/usr/bin/env node
// Deterministic, test-only MCP client that drives one long-running scripted
// RAI session through 8 sequential, increasing-complexity rounds. Unlike
// fake-claude-provider-matrix.mjs (which reads a pre-baked list of proposals
// up front), each round's R code here is *built at runtime* from values the
// JS side extracts out of the previous round's real, native get_run_result
// stdout/error text -- e.g. round 2's vector literal embeds the actual
// integer round 1's Console run produced, round 6's correction embeds the
// actual number parsed out of round 6's own real R `stop()` error text. This
// is the "read the result back and let it inform the next proposal" planning
// loop the extended-session test proves, not just a fixed script replayed
// through the real bridge.
//
// Every round still traverses the real bridge, the real native approval
// card, real Console submission, and the real get_run_result protocol; only
// the "which R code to propose next" decision is deterministic script here
// in place of an LLM.
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
  throw new Error('extended-session provider requires --mcp-config and --test-state-dir');

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
    // MCP is JSON-lines; ignore any non-protocol diagnostics.
  }
});

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function toolResult(msg) {
  const text = msg.result?.content?.[0]?.text;
  if (text) return JSON.parse(text);
  return { status: 'error', error: msg.error?.message ?? 'MCP request failed' };
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const deadline = () => Date.now() + 120000;

async function submit(proposal) {
  const until = deadline();
  while (Date.now() < until) {
    const response = await call('tools/call', { name: 'run_r', arguments: { proposal } });
    const result = toolResult(response);
    if (result.status === 'approval_required') {
      await sleep(250);
      continue;
    }
    if (!result.run_id)
      return result;
    const runId = result.run_id;
    while (Date.now() < until) {
      const resultResponse = await call('tools/call', { name: 'get_run_result', arguments: { run_id: runId } });
      const settled = toolResult(resultResponse);
      if (settled.status !== 'pending')
        return settled;
      await sleep(250);
    }
  }
  return { status: 'error', error: 'extended-session provider timed out waiting for a native result' };
}

// --- Extraction helpers: parse real R output to plan the next round -------
function lastBracketNumber(stdout) {
  const matches = [...String(stdout).matchAll(/\[1\]\s*([-\d.]+)/g)];
  if (!matches.length) throw new Error(`no [1] numeric value found in stdout: ${stdout}`);
  return Number(matches[matches.length - 1][1]);
}

function lastBracketVectorSum(stdout) {
  const match = String(stdout).match(/\[1\]\s*([\d\s.-]+)/);
  if (!match) throw new Error(`no [1] vector line found in stdout: ${stdout}`);
  return match[1].trim().split(/\s+/).map(Number).reduce((sum, n) => sum + n, 0);
}

function dataFrameValueSum(stdout) {
  const rows = [...String(stdout).matchAll(/\n\s*\d+\s+\S+\s+(-?\d+(?:\.\d+)?)/g)];
  if (!rows.length) throw new Error(`no data-frame rows found in stdout: ${stdout}`);
  return rows.reduce((sum, [, value]) => sum + Number(value), 0);
}

function taggedNumber(text, tag) {
  const match = new RegExp(`${tag}=(-?\\d+(?:\\.\\d+)?)`).exec(String(text));
  if (!match) throw new Error(`tag ${tag} not found in: ${text}`);
  return Number(match[1]);
}

// --- The 8-round, 9-proposal session plan ----------------------------------
// Each round's `build` reads only the running `state` object -- which is
// populated exclusively by parsing the *actual* native result of the prior
// round(s) -- so the code proposed for round N genuinely depends on what R
// itself reported for round N-1, not a value baked in ahead of time.
const rounds = [
  {
    round: 1,
    label: 'arithmetic',
    build: () => "{ rai_ext_base <- 15 + 27; rai_ext_base }",
    expectError: false,
    plan: (state, result) => {
      state.base = lastBracketNumber(result.stdout);
    },
  },
  {
    round: 2,
    label: 'vector-ops',
    build: (state) => `{ rai_ext_vec <- ${state.base} + c(1,2,3); rai_ext_vec }`,
    expectError: false,
    plan: (state, result) => {
      state.vecSum = lastBracketVectorSum(result.stdout);
    },
  },
  {
    round: 3,
    label: 'custom-function',
    build: (state) => `{ rai_ext_scale <- function(x, k) x * k; rai_ext_result3 <- rai_ext_scale(${state.vecSum}, 2L); rai_ext_result3 }`,
    expectError: false,
    plan: (state, result) => {
      state.result3 = lastBracketNumber(result.stdout);
    },
  },
  {
    round: 4,
    label: 'apply-loop',
    build: (state) => `{ rai_ext_data <- 1:5; rai_ext_squares <- sapply(rai_ext_data, function(x) x^2); rai_ext_total4 <- sum(rai_ext_squares) + ${state.result3}; rai_ext_total4 }`,
    expectError: false,
    plan: (state, result) => {
      state.total4 = lastBracketNumber(result.stdout);
    },
  },
  {
    round: 5,
    label: 'dataframe-aggregation',
    build: (state) => `{ rai_ext_df <- data.frame(grp = c('a','a','b','b'), val = c(${state.result3}, ${state.total4}, 10, 20)); rai_ext_agg <- aggregate(val ~ grp, data = rai_ext_df, FUN = sum); rai_ext_agg }`,
    expectError: false,
    plan: (state, result) => {
      state.aggSum = dataFrameValueSum(result.stdout);
    },
  },
  {
    round: 6,
    label: 'runtime-error',
    build: (state) => `{ stop(sprintf('RAI_EXT_ERROR_R6=%d', ${state.total4})) }`,
    expectError: true,
    plan: (state, result) => {
      state.errorValue = taggedNumber(result.error, 'RAI_EXT_ERROR_R6');
    },
  },
  {
    round: 6,
    label: 'runtime-error-correction',
    build: (state) => `{ rai_ext_fixed <- ${state.errorValue} + 1L; cat(sprintf('RAI_EXT_CORRECTED=%d\\n', rai_ext_fixed)) }`,
    expectError: false,
    plan: (state, result) => {
      state.fixed = taggedNumber(result.stdout, 'RAI_EXT_CORRECTED');
    },
  },
  {
    round: 7,
    label: 'multi-statement-braced-block',
    build: () => "{ rai_ext_summary_calc <- rai_ext_base + sum(rai_ext_vec) + rai_ext_result3 + rai_ext_total4 + rai_ext_fixed + sum(rai_ext_agg$val); cat(sprintf('RAI_EXT_R7_SUM=%d\\n', rai_ext_summary_calc)) }",
    expectError: false,
    plan: (state, result) => {
      state.r7sum = taggedNumber(result.stdout, 'RAI_EXT_R7_SUM');
    },
  },
  {
    round: 8,
    label: 'final-summary-readback',
    build: () => "{ cat(sprintf('RAI_EXT_FINAL: base=%d vecsum=%d result3=%d total4=%d fixed=%d aggsum=%d r7=%d\\n', rai_ext_base, sum(rai_ext_vec), rai_ext_result3, rai_ext_total4, rai_ext_fixed, sum(rai_ext_agg$val), rai_ext_summary_calc)) }",
    expectError: false,
    plan: (state, result) => {
      state.finalLine = String(result.stdout).match(/RAI_EXT_FINAL:.*/)?.[0];
    },
  },
];

async function main() {
  await call('initialize', { protocolVersion: '2024-11-05' });
  const state = {};
  const results = [];
  const planningLog = [];

  for (const step of rounds) {
    const code = step.build(state);
    const proposal = { language: 'R', target: 'console', code };
    log(`[fake-provider-extended] round ${step.round} (${step.label}) run_r -> ${JSON.stringify(proposal)}`);
    const result = await submit(proposal);
    results.push({ round: step.round, label: step.label, proposal, result });
    writeFileSync(`${stateDir}/results.json`, JSON.stringify(results));
    log(`[fake-provider-extended] round ${step.round} (${step.label}) result <- ${JSON.stringify(result)}`);

    const expectedStatus = step.expectError ? 'error' : 'ok';
    if (result.status !== expectedStatus) {
      log(`[fake-provider-extended] fatal: round ${step.round} (${step.label}) expected status ${expectedStatus} but got ${result.status}`);
      process.exitCode = 1;
      return;
    }

    const stateBefore = { ...state };
    step.plan(state, result);
    planningLog.push({
      round: step.round,
      label: step.label,
      readFrom: step.expectError ? result.error : result.stdout,
      stateBefore,
      stateAfter: { ...state },
    });
    writeFileSync(`${stateDir}/planning.json`, JSON.stringify(planningLog));
  }

  log('[fake-provider-extended] SESSION_COMPLETE');
  // Keep the terminal session stable until fixture teardown; the bridge would
  // otherwise reconnect and recreate the iframe while assertions are running.
  await sleep(90000);
}

main().catch((error) => {
  log(`[fake-provider-extended] fatal: ${error.stack ?? error}`);
  process.exitCode = 1;
}).finally(() => child.kill());
