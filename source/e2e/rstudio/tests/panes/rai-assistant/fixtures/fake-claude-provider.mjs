#!/usr/bin/env node
// Test-only stand-in for the `claude` CLI. Spawned by rai-chat-bridge exactly
// like the real provider (same --mcp-config argv, same per-session MCP
// config file), so it exercises the real rai-native-mcp.js MCP server and
// the real native /run + /result endpoints -- everything except an actual
// LLM deciding to call the tool. That decision is deterministic here instead
// ("propose 20 + 22"), which lets the round trip be proven without touching
// any LLM credentials.
//
// Behavior mirrors what a well-behaved real assistant does: call run_r,
// and if the native broker replies "approval_required", keep retrying the
// same proposal (the broker gate is idempotent per pending request) until a
// human approves it in the RStudio UI, then poll get_run_result until the
// run settles.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { sessionMcpServer } from './session-mcp-server.mjs';

function log(line) {
  process.stdout.write(`${line}\n`);
  if (stateDir) appendFileSync(`${stateDir}/provider.log`, `${line}\n`);
}

function findArg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const configPath = findArg('--mcp-config');
const stateDir = findArg('--test-state-dir');
if (stateDir) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(`${stateDir}/provider.pid`, String(process.pid));
}
if (!configPath) {
  log('[fake-provider] no --mcp-config argv; nothing to do');
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const server = sessionMcpServer(config);
if (!server) {
  log('[fake-provider] no mcpServers.rai entry in MCP config');
  process.exit(1);
}

log('[fake-provider] Welcome to the fake Claude Code stand-in (test harness only)');
log(`[fake-provider] WORKSPACE: ${process.cwd()}`);
log(`[fake-provider] launching MCP server: ${server.command} ${(server.args ?? []).join(' ')}`);

const child = spawn(server.command, server.args ?? [], {
  env: { ...process.env, ...(server.env ?? {}) },
  stdio: ['pipe', 'pipe', 'inherit'],
});
if (stateDir) writeFileSync(`${stateDir}/mcp.pid`, String(child.pid));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
    process.exit(0);
  });
}

const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
let nextId = 1;

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const resolve = pending.get(msg.id);
  if (resolve) {
    pending.delete(msg.id);
    resolve(msg);
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
  return text ? JSON.parse(text) : msg.error;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await call('initialize', { protocolVersion: '2024-11-05' });
  // Keep the terminal visible long enough for the integration test to prove
  // the provider inherited the active RStudio project directory before it
  // submits the run requiring native approval.
  await sleep(1500);

  const proposal = {
    language: 'R',
    target: 'console',
    code: "{ input <- read.csv('rai-mcp-input.csv'); stopifnot(nrow(input) == 4L, identical(names(input), c('group', 'score')), all(input$group %in% c(0, 1))); analysis <- transform(input, centered = score - mean(score)); stopifnot(identical(names(input), c('group', 'score'))); group_mean <- aggregate(score ~ group, data = analysis, FUN = mean); fit <- lm(score ~ group, data = analysis); prediction <- predict(fit, newdata = data.frame(group = c(0, 1))); cat(sprintf('ROWS=%d GROUP_MEANS=%.1f,%.1f SLOPE=%.1f PRED=%.1f,%.1f CENTERED_SUM=%.1f\\n', nrow(input), group_mean$score[1], group_mean$score[2], unname(coef(fit)[['group']]), prediction[1], prediction[2], sum(analysis$centered))) }"
  };
  log(`[fake-provider] run_r -> ${JSON.stringify(proposal)}`);

  let runId;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const response = await call('tools/call', { name: 'run_r', arguments: { proposal } });
    const result = toolResult(response);
    // An approval retry may observe the run while queued, or after the native
    // Console has already settled it. Both responses carry the stable run ID;
    // get_run_result remains the single readback path.
    if (result.status === 'queued' || result.status === 'ok' || result.status === 'error') {
      runId = result.run_id;
      log(`[fake-provider] ${result.status}: ${JSON.stringify(result)}`);
      break;
    }
    if (result.status === 'approval_required') {
      log(`[fake-provider] approval_required -- waiting for native approval in the RStudio UI`);
      await sleep(2000);
      continue;
    }
    log(`[fake-provider] unexpected run_r status: ${JSON.stringify(result)}`);
    await sleep(2000);
  }

  if (!runId) {
    log('[fake-provider] RESULT: run_r produced no run_id');
    return;
  }

  while (Date.now() < deadline) {
    const response = await call('tools/call', { name: 'get_run_result', arguments: { run_id: runId } });
    const result = toolResult(response);
    if (result.status === 'pending') {
      await sleep(500);
      continue;
    }
    log(`[fake-provider] RESULT: ${JSON.stringify(result)}`);
    // The Assistant iframe is deliberately re-created whenever its bridge
    // session reconnects, so xterm scrollback is not a durable test API. Keep
    // the MCP response in the isolated per-test state directory as well. This
    // proves the real get_run_result call observed the native settled result
    // without coupling the E2E to a transient iframe DOM instance.
    if (stateDir) writeFileSync(`${stateDir}/result.json`, JSON.stringify(result));
    if (result.status === 'ok' && String(result.stdout ?? '').includes('ROWS=4 GROUP_MEANS=12.0,22.0 SLOPE=10.0 PRED=12.0,22.0 CENTERED_SUM=0.0')) {
      log('[fake-provider] RESULT_OUTPUT_OK');
    }
    // Process exit immediately after logging races the Assistant terminal's
    // "claude exited -- reconnecting for a fresh session" auto-restart,
    // which clears the xterm buffer before the test's poll can read the
    // RESULT/RESULT_OUTPUT_OK lines just written above. Hold the pty open
    // for the rest of the test's own timeout budget (120s, see
    // test.setTimeout in the spec) so the terminal snapshot stays stable
    // for however long the Console-side assertions take first; the test
    // harness kills this process tree on teardown regardless.
    await sleep(90000);
    return;
  }
  log('[fake-provider] RESULT: timed out waiting for the console run to settle');
}

main().finally(() => child.kill());
