#!/usr/bin/env node
import { peerMac as makePeerMac, peerMatches as callbackMatches, PEER_BODY_MAX_BYTES } from './peer-proof.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { closeSync, fstatSync, openSync, readFileSync, constants } from 'node:fs';
import { validateRConsoleProposal } from './rcode-distiller.js';
import { auditTools, handleAuditTool, captureAuditEvidence, beginAuditEvidence } from './rai-audit-mcp.js';

// This module is the sole native adapter, and it is also a stdio entrypoint.
// Everything above main() is pure and importable (config, env and fetch are
// injected parameters with real defaults, and nothing runs at import time), so
// the validation and timeout logic can be unit-tested without a live rsession.
// main() is the only wiring, and only it touches stdin/stdout. See mcp.js for
// the same split.

// A wedged native listener -- an R Console parked on readline() or browser(),
// or an rsession that died mid-request -- must not hang the tool call, because
// that hangs the assistant's whole turn with no error to report. This bounds
// every request; it is deliberately much longer than a Console round trip so a
// legitimately slow run still completes.
export const NATIVE_REQUEST_TIMEOUT_MS = 30000;
export const MAX_PLOT_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_PROJECT_FILE_TEXT_BYTES = 64 * 1024;
const MAX_CODE_FILE_TOTAL_BYTES = 10 * 1024 * 1024;

export function requireNativeConfig(env = process.env) {
  let token = env.RAI_BRIDGE_TOKEN;
  if (env.RAI_BRIDGE_TOKEN_FILE) {
    let fd;
    try {
      fd = openSync(env.RAI_BRIDGE_TOKEN_FILE, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 ||
          (process.getuid && stat.uid !== process.getuid())) throw new Error();
      token = readFileSync(fd, 'utf8');
    } catch { throw new Error('RAI session token file is invalid'); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  const healthUrl = env.RAI_SESSION_HEALTH_URL;
  if (!token || !healthUrl) throw new Error('RAI session endpoint configuration is required');
  const inspectorUrl = env.RAI_RUN_INSPECTOR_URL;
  if (inspectorUrl !== undefined) {
    let url;
    try { url = new URL(inspectorUrl); } catch { throw new Error('RAI run inspector endpoint configuration is invalid'); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
        url.pathname !== '/internal/run-inspector' || url.username || url.password || url.search || url.hash) {
      throw new Error('RAI run inspector endpoint configuration is invalid');
    }
  }
  return { token, healthUrl, ...(inspectorUrl ? { inspectorUrl } : {}) };
}

export function endpointFor(healthUrl, name) {
  return healthUrl.replace(/\/health$/, `/${name}`);
}

// A run id belongs to one rsession instance. The bridge survives Restart R,
// so retain only this bounded identity mapping and never retry a prior run.
export function createRunSessionRegistry({ maxEntries = 256 } = {}) {
  const entries = new Map();
  return {
    remember(runId, sessionId) {
      if (typeof runId !== 'string' || typeof sessionId !== 'string' || !sessionId) return;
      entries.delete(runId);
      entries.set(runId, sessionId);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    sessionFor(runId) { return entries.get(runId); }
  };
}

const runSessionRegistries = new Map();
function runSessionRegistryFor(config) {
  if (config.runSessionRegistry) return config.runSessionRegistry;
  const key = `${config.healthUrl}\u0000${config.token}`;
  let registry = runSessionRegistries.get(key);
  if (!registry) {
    registry = createRunSessionRegistry();
    runSessionRegistries.set(key, registry);
  }
  return registry;
}

function callbackMac(token, label, nc, nb, method, uri, port, body = '') {
  return makePeerMac(token, label, nc, nb, port, body, method, uri);
}
async function readCallbackChallenge(response) {
  if (!response.ok || !response.body?.getReader) throw new Error('native R session peer proof failed');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > PEER_BODY_MAX_BYTES) throw new Error('native R session peer proof exceeds body limit');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function nativePeerFetch(url, options, { token, fetch = globalThis.fetch }) {
  const target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' ||
      target.username || target.password || target.search || target.hash)
    throw new Error('native R session endpoint configuration is invalid');
  if (Object.keys(options.headers ?? {}).some(name => name.toLowerCase() === 'x-rai-bridge-token'))
    throw new Error('native R session bearer callbacks are disabled');
  const method = options.method;
  const uri = target.pathname;
  const port = target.port || '80';
  const nc = randomBytes(32).toString('hex');
  const challenge = await fetch(new URL('/peer_challenge', target).href, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 1, nc, method, uri }), signal: options.signal, redirect: 'error'
  });
  const proof = await readCallbackChallenge(challenge);
  if (!/^[0-9a-f]{64}$/.test(proof?.nb) ||
      !callbackMatches(proof.proof, callbackMac(token, 'native-cb-proof', nc, proof.nb, method, uri, port)))
    throw new Error('native R session peer proof failed');
  const body = options.body?.toString() ?? '';
  if (Buffer.byteLength(body) > ((uri === "/edit" || uri === "/write") ? 4 * 1024 * 1024 : 4 * PEER_BODY_MAX_BYTES))
    throw new Error((uri === '/edit' || uri === '/write')
      ? 'RAI edit/write request exceeds the 4 MiB form-encoded body limit, including escaping and metadata; no edit was submitted'
      : 'native R session callback exceeds body limit');
  const response = await fetch(url, {
    ...options, redirect: 'error',
    headers: { ...options.headers,
      'X-RAI-Peer-Nonce': proof.nb,
      'X-RAI-Peer-Proof': callbackMac(token, 'mcp-cb-proof', nc, proof.nb, method, uri, port, body) }
  });
  if (!callbackMatches(response.headers?.get('x-rai-peer-ack'),
      callbackMac(token, 'native-cb-ack', nc, proof.nb, method, uri, port, body)))
    throw new Error('native R session peer acknowledgement failed');
  return response;
}

async function currentSessionHealth(config) {
  const timeoutMs = config.timeoutMs ?? NATIVE_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let response;
  try {
    const fetch = config.fetch ?? globalThis.fetch;
    response = await nativePeerFetch(config.healthUrl, {
      method: 'GET',
      signal: controller.signal
    }, { token: config.token, fetch });
  } catch (error) {
    if (timedOut) throw new Error(`native R session did not respond to health within ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) return undefined;
  const result = normalizeNativeResult(await response.json());
  return result;
}

async function currentSessionId(config) {
  const result = await currentSessionHealth(config);
  return typeof result?.session_id === 'string' && result.session_id ? result.session_id : undefined;
}

// r::json::jsonValueFromList turns R scalars into one-element arrays, which is
// not what the run state machine or the MCP wire protocol expect.
export function normalizeNativeResult(result) {
  if (!result || typeof result !== 'object') return result;
  if (Array.isArray(result)) return result.map((entry) => normalizeNativeResult(entry));
  for (const [key, value] of Object.entries(result)) {
    result[key] = normalizeNativeResult(value);
  }
  // 'class' and 'dims' are deliberately absent: they are genuinely vectors in
  // R (c('tbl_df','tbl','data.frame')), so unwrapping the length-1 case would
  // make the same field sometimes a string and sometimes an array.
  for (const key of ['status', 'run_id', 'tainted', 'taint_reason', 'stdout', 'stderr', 'error', 'value_summary', 'message', 'call', 'summary', 'name', 'found', 'traceback_available', 'traceback_unavailable_reason', 'binding', 'binding_count', 'total_count', 'truncated', 'max_bindings', 'row_count', 'column_count', 'columns_truncated', 'scope', 'inspected_rows', 'missing_count']) {
    if (Array.isArray(result[key]) && result[key].length === 1) result[key] = result[key][0];
  }
  return result;
}

export async function callEndpoint(name, values, {
  token,
  healthUrl,
  fetch = globalThis.fetch,
  timeoutMs = NATIVE_REQUEST_TIMEOUT_MS
} = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response;
  try {
    response = await nativePeerFetch(endpointFor(healthUrl, name), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(values),
      signal: controller.signal
    }, { token, fetch });
  } catch (error) {
    if (timedOut) {
      throw new Error(`native R session did not respond to ${name} within ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // A rejected proposal comes back as {status,message}; surface that message,
    // since it is the part that tells the assistant what to fix.
    const detail = await response.json().catch(() => undefined);
    const message = normalizeNativeResult(detail)?.message;
    throw new Error(message
      ? `native R session rejected ${name} (${response.status}): ${message}`
      : `native R session rejected ${name} (${response.status})`);
  }
  return normalizeNativeResult(await response.json());
}

async function sessionRestartedResult(runId, config) {
  const originalSessionId = runSessionRegistryFor(config).sessionFor(runId);
  if (!originalSessionId) return undefined;
  let liveSessionId;
  try { liveSessionId = await currentSessionId(config); } catch { liveSessionId = undefined; }
  if (liveSessionId && liveSessionId !== originalSessionId) {
    return {
      status: 'session_restarted', run_id: runId,
      message: 'R restarted before this result was read; propose a fresh R expression and request a new approval'
    };
  }
  return undefined;
}

// Read-only bridge-side monitor for an already-running native Console capture.
// It deliberately has no reference to /run, Console input, R interruption, or
// process control. Time/sleep injection keeps two-hour policy tests immediate.
export async function monitorConsoleRun(runId, {
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs = 5000,
  noOutputMs = 5 * 60 * 1000,
  monitorTimeoutMs = 2 * 60 * 60 * 1000,
  onSnapshot,
  ...nativeConfig
} = {}) {
  const validatedRunId = validateRunId(runId);
  const startedAt = now();
  let lastOutputBytes;
  let lastOutputAt = startedAt;
  let lastNativeSnapshot = {};

  const emitSnapshot = async (snapshot, state, sampledAt, outputBytes, outputGrowthBytes) => {
    if (typeof onSnapshot !== 'function') return;
    const elapsedMs = Number.isFinite(snapshot.elapsed_ms) && snapshot.elapsed_ms >= 0
      ? Math.floor(snapshot.elapsed_ms)
      : sampledAt - startedAt;
    const payload = {
      state,
      elapsed_ms: elapsedMs,
      quiet_ms: Number.isFinite(snapshot.last_output_age_ms) && snapshot.last_output_age_ms >= 0
        ? Math.floor(snapshot.last_output_age_ms)
        : snapshot.last_output_age_ms === -1 ? elapsedMs : Math.max(0, sampledAt - lastOutputAt),
      output_bytes: outputBytes,
      output_growth_bytes: outputGrowthBytes,
      deadline_ms: Math.max(0, monitorTimeoutMs - (sampledAt - startedAt))
    };
    try { void Promise.resolve(onSnapshot(payload)).catch(() => {}); } catch { /* inspector failure never blocks observation */ }
  };

  for (;;) {
    const restarted = await sessionRestartedResult(validatedRunId, nativeConfig);
    if (restarted) {
      const sampledAt = now();
      await emitSnapshot(lastNativeSnapshot, 'session_restarted', sampledAt, lastOutputBytes ?? 0, 0);
      return restarted;
    }
    const snapshot = await callEndpoint('monitor', { run_id: validatedRunId }, nativeConfig);
    if (!snapshot || snapshot.run_id !== validatedRunId) {
      throw new Error('native R session returned an invalid monitor snapshot');
    }
    const expectedSession = runSessionRegistryFor(nativeConfig).sessionFor(validatedRunId);
    if (expectedSession && snapshot.session_id && snapshot.session_id !== expectedSession) {
      throw new Error('native monitor session identity changed; observation stopped without retry');
    }
    const observedOutputBytes = Number.isSafeInteger(snapshot.output_bytes) && snapshot.output_bytes >= 0
      ? snapshot.output_bytes
      : String(snapshot.stdout ?? '').length + String(snapshot.stderr ?? '').length;
    const retainsTerminalOutput = snapshot.status !== 'running' && observedOutputBytes === 0 &&
      Number.isSafeInteger(lastOutputBytes) && lastOutputBytes > 0;
    const outputBytes = retainsTerminalOutput ? lastOutputBytes : observedOutputBytes;
    const sampledAt = now();
    const outputGrowthBytes = retainsTerminalOutput
      ? 0
      : lastOutputBytes === undefined
        ? outputBytes
        : Math.max(0, outputBytes - lastOutputBytes);
    if (lastOutputBytes === undefined || outputBytes !== lastOutputBytes) {
      lastOutputBytes = outputBytes;
      lastOutputAt = sampledAt;
    }
    lastNativeSnapshot = snapshot;

    if (!['running', 'pending'].includes(snapshot.status)) {
      const state = snapshot.status === 'session_restarted' ? 'session_restarted'
        : snapshot.status === 'not_running' ? 'awaiting_result' : 'settled';
      await emitSnapshot(snapshot, state, sampledAt, outputBytes, outputGrowthBytes);
      return snapshot;
    }

    await emitSnapshot(snapshot, 'running', sampledAt, outputBytes, outputGrowthBytes);

    if (sampledAt - startedAt >= monitorTimeoutMs) {
      const timedOut = { ...snapshot, status: 'timed_out', native_status: snapshot.status, monitor_elapsed_ms: sampledAt - startedAt,
        progress: outputBytes === 0 || sampledAt - lastOutputAt >= noOutputMs ? 'quiet' : 'output_observed',
        liveness: 'responsive', resume_same_run: true };
      await emitSnapshot(timedOut, 'timed_out', sampledAt, outputBytes, 0);
      return timedOut;
    }
    // Silence cannot distinguish legitimate compute from a stall. Only end this
    // observation window; a subsequent call observes the same run without replay.
    await sleep(Math.min(pollIntervalMs, Math.max(0, monitorTimeoutMs - (sampledAt - startedAt))));
  }
}

// The plot endpoint is intentionally binary, and its only argument is a
// bounded integer history index. It returns only an already-rendered
// Plots-pane PNG; this bridge never selects a file, asks R to render, changes
// which plot is active, or accepts data/URLs from the tool caller. Omitting
// index keeps the original active-plot request byte-for-byte.
export async function callPlotImageEndpoint({
  token,
  healthUrl,
  fetch = globalThis.fetch,
  timeoutMs = NATIVE_REQUEST_TIMEOUT_MS
} = {}, index = undefined, notebook = undefined) {
  const kind = notebook ? 'notebook image' : 'plot';
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response;
  try {
    response = await nativePeerFetch(endpointFor(healthUrl, notebook ? 'notebook_image' : 'plot'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(notebook ?? (index === undefined ? {} : { index: String(index) })),
      signal: controller.signal
    }, { token, fetch });
  } catch (error) {
    if (timedOut) throw new Error(`native R session did not respond to ${kind} within ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await response.json().catch(() => undefined);
    const message = normalizeNativeResult(detail)?.message;
    throw new Error(message
      ? `native R session rejected ${kind} (${response.status}): ${message}`
      : `native R session rejected ${kind} (${response.status})`);
  }

  const contentType = response.headers?.get('content-type') ?? '';
  if (contentType.split(';', 1)[0].trim().toLowerCase() !== 'image/png') {
    throw new Error('native R session plot response is not PNG');
  }
  const lengthHeader = response.headers?.get('content-length');
  const declaredLength = Number(lengthHeader);
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 1) {
    throw new Error('native R session plot response has no valid content length');
  }
  if (declaredLength > MAX_PLOT_IMAGE_BYTES) {
    throw new Error('native R session plot image exceeds 4 MB');
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== declaredLength) {
    throw new Error('native R session plot response length did not match content length');
  }
  if (bytes.byteLength > MAX_PLOT_IMAGE_BYTES) {
    throw new Error('native R session plot image exceeds 4 MB');
  }
  // Defense in depth: a content-type header alone must not turn arbitrary
  // binary data into an MCP image result.
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.byteLength < pngSignature.length || !pngSignature.every((byte, index) => bytes[index] === byte)) {
    throw new Error('native R session plot response is not a valid PNG');
  }
  return Buffer.from(bytes).toString('base64');
}

export function validateToolArguments(value, allowed, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tool arguments must be an object');
  }
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error('tool arguments contain unsupported fields');
  }
  if (required.some((key) => !(key in value))) {
    throw new Error('tool arguments are missing required fields');
  }
  return value;
}

export function validateMaxLines(value) {
  if (value === undefined) return 200;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
    throw new Error('max_lines must be an integer between 1 and 1000');
  }
  return value;
}

export function validateRunId(value) {
  if (typeof value !== 'string' || !/^run-[A-Za-z0-9-]{1,128}$/.test(value)) {
    throw new Error('run_id is invalid');
  }
  return value;
}

export function validateObjectNames(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 20 ||
      value.some((name) => typeof name !== 'string' || !/^[A-Za-z.][A-Za-z0-9._]{0,127}$/.test(name))) {
    throw new Error('object_names must be an array of 1 to 20 bare R identifiers');
  }
  return value;
}

// summary_mode is a closed enum, never an expression: 'full' returns the
// existing bounded per-object detail, 'nrow' asks native for row-count-only
// detail. There is no third value and no free-form string.
export function validateSummaryMode(value) {
  if (value === undefined) return undefined;
  if (value !== 'full' && value !== 'nrow') {
    throw new Error('summary_mode must be "full" or "nrow"');
  }
  return value;
}

// requested_columns is the same bare-identifier contract as object_names
// (1..20 entries, no expressions/subsetting/namespaces), but only makes
// sense alongside object_names -- native has nothing to select columns
// from otherwise.
export function validateRequestedColumns(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 20 ||
      value.some((name) => typeof name !== 'string' || !/^[A-Za-z.][A-Za-z0-9._]{0,127}$/.test(name))) {
    throw new Error('requested_columns must be an array of 1 to 20 bare R identifiers');
  }
  return value;
}

// A plot history index is an ordinal into the session's own Plots-pane list,
// never a path, id, or size. Whether it is actually in range is the native
// boundary's call -- it alone knows the live plot count -- so this only fixes
// the type and an absurd upper bound before anything leaves this process.
export function validatePlotIndex(value) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0 || value > 999) {
    throw new Error('index must be an integer between 0 and 999');
  }
  return value;
}

export function validateProposalId(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(value)) {
    throw new Error('proposal_id is invalid');
  }
  return value;
}

export function validateDocumentId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) {
    throw new Error('document_id is invalid');
  }
  return value;
}

export function validateDocumentEditText(value, field) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 32768) {
    throw new Error(`${field} must be a non-empty string of at most 32768 characters`);
  }
  return value;
}

// context_before/context_after anchor an edit against the literal text
// immediately surrounding expected_text. Bounded to the same 1..2048 byte
// window the native session enforces; this is a wire-boundary courtesy
// check only -- native independently re-validates adjacency against the
// live document, both at request time and again immediately before apply.
export function validateDocumentEditContext(value, field) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) {
    throw new Error(`${field} must be a non-empty string of at most 2048 characters`);
  }
  return value;
}

// Wire-boundary check ONLY: catches empty, absolute-looking, ".."-containing,
// and NUL-containing paths before a network call, and caps length so an
// absurd string cannot be marshalled at all. This is a courtesy, not the
// security boundary -- the native endpoint independently re-resolves and
// re-validates the same path against the live project root, follows no
// symlink outside it, and is the ONLY component that ever touches disk. This
// function never reads a file and never runs in a context with filesystem
// access of its own.
export function validateProjectFilePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096) {
    throw new Error('path must be a non-empty string of at most 4096 characters');
  }
  if (value.includes('\0')) {
    throw new Error('path must not contain a NUL byte');
  }
  if (value.startsWith('/') || value.startsWith('\\')) {
    throw new Error('path must be project-relative, not absolute');
  }
  // Windows drive-letter absolute form (C:\...) and a bare ".." or any "../"
  // / "..\" component, at the start, middle, or end of the path.
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error('path must be project-relative, not absolute');
  }
  const segments = value.split(/[\\/]+/);
  if (segments.some((segment) => segment === '..')) {
    throw new Error('path must not contain a ".." component');
  }
  const lowered = segments.filter(Boolean).map(segment => segment.toLowerCase());
  // This validator is read-only: ordinary environment sources are forwarded
  // for native project/text validation. Internal auth/state stays unreadable.
  if (lowered.includes('.raistudio')) {
    throw new Error('protected environment/profile file cannot be read by the Assistant');
  }
  return value;
}

export function validateProjectFileOffset(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10 * 1024 * 1024) {
    throw new Error('offset must be a non-negative integer no greater than 10485760');
  }
  return value;
}

// Keep automatic proposal identities only long enough to survive an MCP retry.
// main() owns the production cache; injected configs can supply an isolated one,
// so importing this module remains free of I/O and session setup.
export function createProposalIdentityCache({ maxEntries = 256, ttlMs = 5 * 60 * 1000, now = Date.now } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('maxEntries must be a positive integer');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('ttlMs must be a positive integer');

  const entries = new Map();
  const removeExpired = () => {
    const current = now();
    for (const [fingerprint, entry] of entries) {
      if (entry.expiresAt <= current) entries.delete(fingerprint);
    }
  };

  return {
    getOrCreate(fingerprint) {
      removeExpired();
      const existing = entries.get(fingerprint);
      if (existing) {
        // Refresh insertion order so the bounded map behaves as an LRU cache.
        entries.delete(fingerprint);
        entries.set(fingerprint, existing);
        return existing.proposalId;
      }

      const proposalId = randomUUID();
      entries.set(fingerprint, { proposalId, expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      return proposalId;
    },
    forget(fingerprint, proposalId) { if (entries.get(fingerprint)?.proposalId === proposalId) entries.delete(fingerprint); }
  };
}

function proposalFingerprint(code, maxLines) {
  return createHash('sha256').update(JSON.stringify({ code, maxLines })).digest('base64url');
}

// Auto-created caches are keyed by the injected config object. Weak ownership
// avoids retaining test callers or alternate MCP sessions beyond their lifetime.
const proposalIdentityCaches = new WeakMap();
const autoRunProposals = new WeakMap();

function releaseCompletedAutoProposal(runId, result, config) {
  const completion = Array.isArray(result?.completion) ? result.completion[0] : result?.completion;
  if (result?.run_id !== runId || !['ok','error','indeterminate'].includes(result.status) ||
      completion !== 'top_level_prompt' || result.console_busy !== false || result.tainted !== false) return;
  const records = autoRunProposals.get(config);
  const record = records?.get(runId);
  if (!record) return;
  proposalIdentityCacheFor(config).forget?.(record.fingerprint, record.proposalId);
  records.delete(runId);
}

function proposalIdentityCacheFor(config) {
  if (config.proposalIdCache && typeof config.proposalIdCache.getOrCreate === 'function') {
    return config.proposalIdCache;
  }
  let cache = proposalIdentityCaches.get(config);
  if (!cache) {
    cache = createProposalIdentityCache();
    proposalIdentityCaches.set(config, cache);
  }
  return cache;
}

function resolveProposalId(runArgs, code, maxLines, config) {
  const suppliedProposalId = validateProposalId(runArgs.proposal_id);
  if (suppliedProposalId) return suppliedProposalId;
  return proposalIdentityCacheFor(config).getOrCreate(proposalFingerprint(code, maxLines));
}

export const tools = [
  {
    name: 'run_r',
    description: 'First translate the user request into a separate, complete executable R code chunk. Then propose only that code for the active RAI-Studio Console. Never pass the user request, explanation, Markdown, shell, or tool prose as code. Exactly one R statement per call. Multiple steps must be wrapped as ONE braced statement `{ step1; step2 }`. A braced block shows only its last value, so wrap anything you need to see in `print()`. Do not use `withAutoprint()`: native policy refuses it (no approved effect contract). A proposal_id is queued at most once; retry the same proposal with its original id. Valid parser-checked Console proposals are automatically approved and queue without a consent card; native validation and existing request decisions still apply. Original data is never edited directly: code that would rebind, modify in place, remove, or overwrite an existing workspace object or existing file, write environment/profile files, run a shell, or evaluate computed code is refused outright (status error, policy refused), never offered for approval. The same policy refuses known secret locations (SSH keys, cloud credentials, .Renviron, .env, shell history, browser data, the assistant\'s own state folder), full environment dumps and secret-named environment variables, and subprocess and foreign-code helpers. Native policy does not block network access, so use it only when the user asks. Expect a refusal for any call outside the policy and do not retry it in another form. These guards bind RAI tools only, not the CLI\'s own tools, and RAI does not sandbox those. Read original data and assign every transformation to a NEW object name or a NEW literal file path. Every run is recorded with its exact code in a durable local trace; get_run_result links the trace and reports observed data effects, which are run-boundary evidence, not complete lineage. After queuing, this is not fire-and-forget: poll get_run_result until it settles (see that tool\'s description), read the full stdout/stderr/warnings/errors, then call get_environment_summary to confirm the code actually did what it should to .GlobalEnv (new/changed bindings, data frame shape). Figure inspection protocol: call get_plot_history first. Plotting calls such as plot() are refused through run_r, so do not propose them; ask the user to draw the figure in the Console, then call get_plot_history again and get_plot_image only for the newly observed active/history entry. Do not create scratch files or control graphics devices: never call png, jpeg, tiff, bmp, svg, pdf, postscript, cairo_pdf, dev.new, dev.off, dev.copy, dev.print, recordPlot, replayPlot, or source. Use the current RAI-Studio graphics device only. Do not claim its dimensions, DPI, page count, or equivalence to a knitr render; those require an explicitly approved separate workflow. Approved code is never evaluated by this MCP process itself.',
    inputSchema: {
      type: 'object',
      properties: {
        proposal: {
          type: 'object',
          description: 'Strict Console boundary. Derive this from the chat request; do not copy the request itself.',
          properties: {
            language: { const: 'R' },
            target: { const: 'console' },
            code: { type: 'string', description: 'Complete executable R only, without prose or shell commands. Exactly one top-level statement.' }
          },
          required: ['language', 'target', 'code'],
          additionalProperties: false
        },
        proposal_id: {
          type: 'string',
          pattern: '^[A-Za-z0-9-]{1,128}$',
          description: 'Opaque proposal identity. Reuse the same value when retrying the same logical proposal.'
        },
        max_lines: { type: 'integer', minimum: 1, description: 'Maximum captured result lines.' }
      },
      required: ['proposal'],
      additionalProperties: false
    }
  },
  {
    name: 'get_active_document_context',
    description: 'Read only bounded metadata for the currently focused open read-eligible code or text document: opaque document id, type, and unsaved state. Returns active:false when the selected source tab is absent or not eligible. This never returns a path, selection, or document contents. Known secret locations and internal .raistudio auth/state are refused. Readability never grants edit eligibility: environment writes remain refused.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
  },
  {
    name: 'list_open_documents',
    description: 'List currently open read-eligible code and text documents in this RAI-Studio session. Returns opaque document ids and bounded metadata, never filesystem paths outside documents already open in the IDE. read_only reports native document metadata, not RAI edit permission. Known secret locations and internal .raistudio auth/state are refused. Readability never grants edit eligibility: environment writes remain refused.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
  },
  {
    name: 'read_open_document',
    description: 'Read a 64 KB UTF-8 page from the current in-memory read-eligible code or text buffer by opaque document_id, including unsaved content. For the next page pass next_offset and the preceding content_digest as expected_digest; a changed buffer is refused. Never reads a path or closed file; total document limit 10 MB. Known secret locations and internal .raistudio auth/state are refused. Readability never grants edit eligibility: environment writes remain refused. Reading returned content shares it with the selected model provider. Only a full code file read mints a session read token: consume all contiguous pages starting at zero with unchanged content_digest (and disk revision for project files). Partial reads, final-page-only reads and run_r reads do not mint tokens. Readability alone never grants write permission.',
    inputSchema: {
      type: 'object',
      properties: { document_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,256}$' }, offset: { type: 'integer', minimum: 0, maximum: 10485759 }, expected_digest: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
      required: ['document_id'], additionalProperties: false
    }
  },
  {
    name: 'edit_document',
    description: 'Code files only: raw, reference, data, environment, config and unknown types are refused and must be edited by the user. Deny wins across every path spelling, even with a code extension. These guards bind RAI tools only; native Bash/Edit remain unaffected. RAI saves its own applied edits to disk automatically and no setting turns this off. Read whole file first through the matching RAI read tool; run_r reads do not mint tokens. Edit an already-open code document. Whole-buffer arguments document_id, expected_digest and contents are mutually exclusive with snippet arguments document_id, expected_text and replacement (plus optional paired context). Use the full read content_digest as expected_digest for whole-buffer mode. Whole-buffer contents may be empty; old and new contents must be NUL-free UTF-8 within the existing 10 MiB reader bound. The complete /edit or /write request is limited to 4 MiB of form-encoded bytes, including escaping and metadata. Snippets retain their existing 32 KiB limits. Both modes require current full-read authority. document_id must come from list_open_documents. In snippet mode expected_text must occur exactly once in the current in-memory document; replacement is applied through the native exact-match path. edit_document waits for the editor preimage acknowledgement. A conflict preserves the human buffer and reports conflict. A clean named UTF-8/LF code document is saved automatically through the common editor save core after completion tracing and a durable pre-edit backup, without formatting or source-on-save execution. Native rechecks authorization, path, classifier and authorized disk identity/bytes at the write boundary. Untitled documents stay unsaved; unrelated dirty state is refused. Only saved=true confirms disk persistence; save failures report Edit applied; file not saved and retain dirty state. Identical polling and acknowledgements are cached; never replay an uncertain disk write. Editor Undo changes the buffer only. Disk rollback requires matching editor and disk postimages. A filesystem check/write race remains because arbitrary external writers do not participate in compare-and-swap. In snippet mode for an .Rmd document, context_before and context_after (the literal text immediately preceding/following expected_text, 1-2048 bytes each) are both required; for other code documents they are optional, but must be supplied together or not at all. A fresh valid exact code edit is automatically approved without an approval card and returns status applying. Existing requests keep their native decisions; legacy approval_required requests remain pending and are never implicitly granted. The native code revalidates document identity, the unique anchor/context, read-only state and the buffer audit immediately before applying, and editor Undo changes only the buffer, not a saved disk file. Environment/profile/workspace files (.Rprofile, .Renviron, .RData, *.rda, .Rhistory, renv.lock) are refused outright and never offered for approval. An applying or approval_required response is pending: poll with identical arguments to observe the same request, never a different replacement or new request. Only a native terminal response (applied, conflict or error) establishes the outcome; unchanged source or audit status does not prove it. A stale/rejected edit is terminal: re-read the current buffer and propose a fresh exact edit. Stop edit calls after a native decline and retain the finding as unresolved.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,256}$' },
        expected_digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        contents: { type: 'string', maxLength: MAX_CODE_FILE_TOTAL_BYTES },
        expected_text: { type: 'string', minLength: 1, maxLength: 32768 },
        replacement: { type: 'string', minLength: 1, maxLength: 32768 },
        context_before: { type: 'string', minLength: 1, maxLength: 2048, description: 'Literal text immediately preceding expected_text. Required for .Rmd; optional (but must accompany context_after) for other code documents.' },
        context_after: { type: 'string', minLength: 1, maxLength: 2048, description: 'Literal text immediately following expected_text. Required for .Rmd; optional (but must accompany context_before) for other code documents.' }
      },
      required: ['document_id'],
      oneOf: [
        { required: ['expected_text', 'replacement'], not: { anyOf: [{ required: ['contents'] }, { required: ['expected_digest'] }] } },
        { required: ['expected_digest', 'contents'], not: { anyOf: ['expected_text', 'replacement', 'context_before', 'context_after'].map(field => ({ required: [field] })) } }
      ], additionalProperties: false
    }
  },
  {
    name: 'get_run_result',
    description: 'Read the stored result of a previously queued R Console run. This never re-executes code. status:"pending" or status:"running" means the native Console has not finished yet -- this is NOT a final answer. Call get_run_result again after a short pause (a few seconds, longer for a slower or heavier expression) and keep polling until status becomes "ok", "error", "indeterminate", "unknown", or "expired". Indeterminate is completed but not verified: preserve native stderr, stop polling, and require a fresh scoped verification proposal, never automatic replay. Check exact output and completion before reporting anything or moving to the next step. Never treat a pending/running read as completion, and never re-run or resubmit the same code while waiting. A result marked tainted:true had unrelated Console activity during its capture, so its text may not belong to this run alone.',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string' } },
      required: ['run_id'],
      additionalProperties: false
    }
  },
  {
    name: 'monitor_console_run',
    description: 'Observe one already-queued native Console run. Read-only heartbeat every 5 seconds; observation_ms defaults to 30000 and is bounded to 1000..7200000. Quiet output is NOT proof of stall. A timed_out observation leaves R untouched and can be renewed with the SAME run_id, never resubmitted code. not_running alone is not completion: require the matching stored result with top-level nonbusy prompt and explicit outcome checks. Errors require a fresh validated proposal; never interrupt, restart, or automatically retry R.',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string', pattern: '^run-[A-Za-z0-9_-]{1,128}$' }, observation_ms: { type: 'integer', minimum: 1000, maximum: 7200000 } },
      required: ['run_id'], additionalProperties: false
    }
  },
  {
    name: 'get_debug_info',
    description: 'Read bounded diagnostics from one existing R Console run. Optional object_names are only bare R identifiers; native reflection is bounded to .GlobalEnv with no evaluation, Console input, or file access. Traceback availability is reported truthfully; this Console capture cannot claim call frames it did not capture.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        object_names: {
          type: 'array', minItems: 1, maxItems: 20,
          items: { type: 'string', pattern: '^[A-Za-z.][A-Za-z0-9._]{0,127}$' }
        }
      },
      required: ['run_id'],
      additionalProperties: false
    }
  },
  {
    name: 'write_project_file',
    description: 'Code files only: raw, reference, data, environment, config and unknown types are refused and must be edited by the user. Deny wins across every path spelling, even with a code extension. These guards bind RAI tools only; native Bash/Edit remain unaffected. RAI saves its own applied edits to disk automatically and no setting turns this off. Read whole file first through the matching RAI read tool; run_r reads do not mint tokens. Overwrite an existing unopened project code file through /write after a full read_project_file read. Supply path, expected_digest from content_digest, and complete contents. No file creation. Use edit_document for an open IDE buffer. Old and new contents must be NUL-free UTF-8 within the existing 10 MiB reader bound; empty replacement is allowed. The complete /write request is limited to 4 MiB of form-encoded bytes, including escaping and metadata. Native checks current digest/revision and path policy before replacement. A successful applied response returns the new digest; a disk write occurred but completion unverified error requires a fresh full read, not automatic replay.',
    inputSchema: { type: 'object', properties: {
      path: { type: 'string', minLength: 1, maxLength: 4096 },
      expected_digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      contents: { type: 'string', maxLength: MAX_CODE_FILE_TOTAL_BYTES }
    }, required: ['path', 'expected_digest', 'contents'], additionalProperties: false }
  },
  {
    name: 'read_project_file',
    description: 'Read only one UTF-8/plain-text file already inside the RAI-Studio session\'s active project, by project-relative path. Reads return at most 64 KB; for a larger text file, use next_offset returned by this tool as offset to retrieve the next bounded page. Files over 10 MB, directories, binary content, and any path that does not exist in the project are rejected. Requires an active project (same posture as get_project_context: no working- or home-directory fallback) and a non-empty path with no absolute component, no ".." component, and no NUL byte; the native endpoint independently re-resolves and re-validates that the path still resolves inside the project root before reading. This never lists a directory, never returns an absolute path, never writes, and never reads through Node\'s own filesystem access -- only through the native session endpoint. This tool refuses known secret locations (SSH keys, cloud credentials, .Renviron, .env, shell history, browser data, the assistant\'s own state folder), the same files run_r refuses, and internal .raistudio auth/state is refused. Reading returned content shares it with the selected model provider. Use read_open_document instead for a buffer already open in the IDE. Only a full code file read mints a session read token: consume all contiguous pages starting at zero with unchanged content_digest (and disk revision for project files). Partial reads, final-page-only reads and run_r reads do not mint tokens. Readability alone never grants write permission.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 4096 },
        offset: { type: 'integer', minimum: 0, maximum: 10485760, description: 'Byte offset from a prior next_offset; omit for the first 64 KB page.' }
      },
      required: ['path'], additionalProperties: false
    }
  },
  {
    name: 'get_project_context',
    description: 'Read only metadata about the RAI-Studio session\'s already-active project: whether a project is active, its root directory name, and the current working directory expressed relative to that root. It accepts no arguments, never lists, stats, or reads raw project-folder files, never returns an absolute path or parent directory, and never falls back to the working or home directory when no project is open. Use read_open_document only for a buffer already opened in RAI-Studio.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
  },
  {
    name: 'authorize_existing_derived_binding',
    description: 'Automatically authorizes one existing normal .GlobalEnv plot collection, function helper, or output-path binding for safe plain rebinding without a consent card. Native verifies bounded type and exact binding identity twice; historical derivation is not machine-proven. Names alone never grant permission. Existing pending or terminal decisions are not replayed or auto-cancelled. Raw data frames, active bindings, promises, environment files, direct in-place mutation and dynamic execution retain their existing RAI refusals. Never invoke during an observational audit; use only for explicitly requested execution.',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string', pattern: '^[A-Za-z.][A-Za-z0-9._]{0,127}$' },
      kind: { type: 'string', enum: ['plots', 'helper', 'path'] }
    }, required: ['name', 'kind'], additionalProperties: false }
  },
  {
    name: 'get_environment_summary',
    description: 'Read only bounded read-only metadata for bindings that already exist in .GlobalEnv. With no arguments it lists up to 100 non-hidden binding names with their binding kind (value, promise, or active_binding) and class; with object_names it returns per-object detail suitable for reasoning about a Data Viewer table -- class, dimensions, row/column counts, column names with their classes, and the same bounded str()-like summary get_debug_info uses. Every class field is an array of class names, and column lists are capped at 40 with columns_truncated reporting the cap. It never evaluates code, never forces a promise or active binding, never reads values or cell data, never dumps an object, and never reaches outside .GlobalEnv. To see actual data, propose R through run_r instead.',
    inputSchema: {
      type: 'object',
      properties: {
        object_names: {
          type: 'array', minItems: 1, maxItems: 20,
          items: { type: 'string', pattern: '^[A-Za-z.][A-Za-z0-9._]{0,127}$' },
          description: 'Bare R identifiers that already exist in .GlobalEnv. Omit to list bindings instead.'
        },
        summary_mode: {
          type: 'string', enum: ['full', 'nrow'],
          description: 'Detail level for object_names entries. "full" (default) returns the existing bounded per-object detail; "nrow" returns row-count-only detail.'
        },
        requested_columns: {
          type: 'array', minItems: 1, maxItems: 20,
          items: { type: 'string', pattern: '^[A-Za-z.][A-Za-z0-9._]{0,127}$' },
          description: 'Bare column identifiers to restrict per-object detail to, alongside object_names.'
        }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: 'get_plot_image',
    description: "Read only an already-rendered RAI-Studio Plots-pane PNG history item: the current active plot, or with an integer index that exact position in the session's plot history, as reported by get_plot_history. It never returns a generated crop of that image, and it makes no promise about native display resolution beyond the pixel dimensions of the returned PNG. It does not execute or enqueue R Console code, does not request approval, does not re-render, does not change which plot is active, and never returns data, files, or any device output -- only that one already-existing history PNG or a safe failure. It fails safely if there is no active plot, the index is outside the history, that history entry has no already-rendered image (get_plot_history reports which do), or the rendered PNG exceeds 4 MB. Do not make text-level claims beyond what the returned PNG's own pixels show: label truncation, spelling, or overlap require native-resolution evidence from an explicitly approved workflow; otherwise report the image limitation rather than infer a defect.",
    inputSchema: {
      type: 'object',
      properties: {
        index: {
          type: 'integer', minimum: 0, maximum: 999,
          description: 'Zero-based position in the plot history from get_plot_history. Omit for the active plot.'
        }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    name: 'get_plot_history',
    description: 'Read only bounded metadata about the RAI-Studio Plots pane history: how many plots the session holds, which zero-based index is active, and for each index whether an already-rendered image exists that get_plot_image can return without re-rendering. This accepts no arguments, returns no image data, no paths, and no URLs, executes no R Console code, and does not change which plot is active. A zero-count Plots-pane history does not prove the absence of file-device or knitr output: png/pdf/svg and other file devices, and Knitr/R Markdown rendering, produce files that never touch the Plots pane and are invisible to this tool.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false
    }
  },
  {
    name: 'list_notebook_outputs',
    description: 'List bounded existing cached PNG outputs for one already-open R Markdown document. Returns opaque chunk and ordinal IDs, current open-buffer digest/revision, count, truncation and dirty/cache provenance; no image, file path, replay, render or R execution. This is historical cache, never proof of a current Console run or chunk execution. Cached outputs may be stale even if the buffer is not dirty. An empty Plots pane does not affect this inventory.',
    inputSchema: {type:'object',properties:{document_id:{type:'string',pattern:'^[A-Za-z0-9_-]{1,256}$'}},required:['document_id'],additionalProperties:false}
  },
  {
    name: 'get_notebook_output_image',
    description: 'Read exactly one already-cached PNG from list_notebook_outputs, bound to the same open-buffer digest. Reject a changed or dirty-to-changed document before reading. Returns explicit historical-cache provenance alongside pixels. The cache may still be stale for an unchanged document; never attribute it to a new Console run, redraw or chunk execution. No caller path, rerun or UI mutation.',
    inputSchema: {type:'object',properties:{document_id:{type:'string',pattern:'^[A-Za-z0-9_-]{1,256}$'},chunk_id:{type:'string',pattern:'^[A-Za-z0-9_-]{1,128}$'},ordinal:{type:'string',pattern:'^[a-f0-9]{6}$'},expected_document_digest:{type:'string',pattern:'^[a-f0-9]{64}$'}},required:['document_id','chunk_id','ordinal','expected_document_digest'],additionalProperties:false}
  },
  {
    name: 'get_viewer_state',
    description: 'Read only bounded metadata about the current RAI-Studio Viewer pane: whether it is active, its kind (html_widget or other), and its transport (session_temp or http). This accepts no arguments and never returns the viewer\'s URL, host, path, query, fragment, or rendered HTML.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false
    }
  }
];

// Tools that must keep the provider CLI's own permission prompt in front of
// them. Empty by design: the native
// session now auto-grants both run_r and edit_document unconditionally (see
// .rs.rai.checkGate and .rs.rai.queueDocumentEdit in SessionRaiAssistant.R),
// so a second, less informative CLI-side prompt in front of an already-
// auto-approved native card would just be dead friction. Previously held
// edit_document, since the native session raised a card for it
// unconditionally; that carve-out was intentionally reversed the same
// evening it was designed, so keep this list here (not deleted) as the one
// place to restore it if the gate needs to come back.
export const APPROVAL_GATED_TOOL_NAMES = [];

// Tool names the provider CLI may call without its own permission prompt,
// qualified for the "rai" MCP server. Derived from `tools` rather than written
// out, so a connector added above cannot silently be left off this list, and
// one added to APPROVAL_GATED_TOOL_NAMES cannot silently stay on it.
export function cliAllowedToolNames() {
  return tools
    .map((tool) => tool.name)
    .filter((name) => !APPROVAL_GATED_TOOL_NAMES.includes(name))
    .map((name) => `mcp__rai__${name}`);
}

tools.push(...auditTools);
const auditIO = { health: currentSessionHealth, endpoint: callEndpoint };

// Returns the JSON-RPC response object, or undefined when the line is not a
// request worth answering. Every argument is validated here, before any network
// call, so a malformed proposal never reaches the native endpoint.
export async function handleRequest(request, config = {}) {
  if (request.id === undefined) return undefined;

  try {
    if (request.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'rai-native-console', version: '0.1.0' }
        }
      };
    }

    if (request.method === 'tools/list') {
      return { jsonrpc: '2.0', id: request.id, result: { tools } };
    }

    if (request.method === 'tools/call') {
      const args = request.params?.arguments ?? {};
      let result;
      let content;
      let evidenceBinding;
      const readEndpoint = async (name, values) => {
        evidenceBinding = await beginAuditEvidence(config, auditIO);
        return callEndpoint(name, values, config);
      };
      if (auditTools.some(tool => tool.name === request.params?.name)) {
        result = await handleAuditTool(request.params.name, args, config, auditIO);
      } else if (request.params?.name === 'run_r') {
        const runArgs = validateToolArguments(args, ['proposal', 'proposal_id', 'max_lines'], ['proposal']);
        const code = validateRConsoleProposal(runArgs.proposal);
        const maxLines = validateMaxLines(runArgs.max_lines);
        const proposalId = resolveProposalId(runArgs, code, maxLines, config);
        result = await callEndpoint('run', { code, proposal_id: proposalId, max_lines: String(maxLines) }, config);
        if (['queued','ok','error'].includes(result?.status) && typeof result.run_id === 'string') {
          if (!runArgs.proposal_id) {
            if (!autoRunProposals.has(config)) autoRunProposals.set(config, new Map());
            const records = autoRunProposals.get(config);
            records.set(result.run_id, {fingerprint:proposalFingerprint(code, maxLines), proposalId});
            while (records.size > 256) records.delete(records.keys().next().value);
          }
          let sessionId = typeof result.session_id === 'string' ? result.session_id : undefined;
          if (!sessionId) {
            try { sessionId = await currentSessionId(config); } catch { sessionId = undefined; }
          }
          if (sessionId) runSessionRegistryFor(config).remember(result.run_id, sessionId);
        }
      } else if (request.params?.name === 'get_active_document_context') {
        validateToolArguments(args, [], []);
        result = await readEndpoint('active_document', {});
      } else if (request.params?.name === 'list_open_documents') {
        validateToolArguments(args, [], []);
        result = await readEndpoint('documents', {});
      } else if (request.params?.name === 'read_open_document') {
        const documentArgs = validateToolArguments(args, ['document_id', 'offset', 'expected_digest'], ['document_id']);
        const values = { document_id: validateDocumentId(documentArgs.document_id) };
        if (documentArgs.offset !== undefined) {
          if (!Number.isSafeInteger(documentArgs.offset) || documentArgs.offset < 0 || documentArgs.offset >= 10 * 1024 * 1024)
            throw new Error('invalid document page offset');
          values.offset = String(documentArgs.offset);
        }
        if (documentArgs.expected_digest !== undefined) {
          if (typeof documentArgs.expected_digest !== 'string' || !/^[a-f0-9]{64}$/.test(documentArgs.expected_digest))
            throw new Error('invalid document digest');
          values.expected_digest = documentArgs.expected_digest;
        }
        if (documentArgs.offset > 0 && !values.expected_digest)
          throw new Error('paged reads require prior document digest');
        result = await readEndpoint('document', values);
      } else if (request.params?.name === 'edit_document') {
        const editArgs = validateToolArguments(
          args,
          ['document_id', 'expected_text', 'replacement', 'context_before', 'context_after', 'expected_digest', 'contents'],
          ['document_id']
        );
        // A lone context field can never anchor an edit by itself: both or
        // neither, checked here before any network call. Native separately
        // enforces that an .Rmd edit requires the pair -- this bridge cannot
        // know the document's type without a round trip, so it only rejects
        // the half-supplied case.
        const wholeFile = 'contents' in editArgs || 'expected_digest' in editArgs;
        if (wholeFile && (!('contents' in editArgs) || !('expected_digest' in editArgs) ||
            ['expected_text', 'replacement', 'context_before', 'context_after'].some(field => field in editArgs)))
          throw new Error('whole-buffer and snippet arguments are mutually exclusive');
        if (wholeFile && (typeof editArgs.contents !== 'string' || Buffer.byteLength(editArgs.contents) > MAX_CODE_FILE_TOTAL_BYTES ||
            editArgs.contents.includes('\0') || typeof editArgs.expected_digest !== 'string' || !/^[a-f0-9]{64}$/.test(editArgs.expected_digest)))
          throw new Error('invalid whole-buffer contents or expected_digest');
        const hasContextBefore = 'context_before' in editArgs;
        const hasContextAfter = 'context_after' in editArgs;
        if (hasContextBefore !== hasContextAfter) {
          throw new Error('context_before and context_after must be supplied together or not at all');
        }
        const values = wholeFile ? {
          document_id: validateDocumentId(editArgs.document_id),
          expected_digest: editArgs.expected_digest, contents: editArgs.contents
        } : {
          document_id: validateDocumentId(editArgs.document_id),
          expected_text: validateDocumentEditText(editArgs.expected_text, 'expected_text'),
          replacement: validateDocumentEditText(editArgs.replacement, 'replacement')
        };
        if (hasContextBefore) {
          values.context_before = validateDocumentEditContext(editArgs.context_before, 'context_before');
          values.context_after = validateDocumentEditContext(editArgs.context_after, 'context_after');
        }
        result = await callEndpoint('edit', values, config);
        if (result?.status === 'approval_required') {
          result = {...result, approval_observation: 'Poll edit_document with identical arguments to observe the same request. This is status observation, not a new edit. Do not infer a decision from unchanged source or audit_session status. When native reports approval declined, stop edit calls and continue read-only audit reporting; never bypass exact Allow-once.'};
        } else if (result?.status === 'applying') {
          result = {...result, approval_observation: 'Automatic approval: the exact edit is being applied natively without a card. Poll edit_document with identical arguments to observe the same request until it reports applied or error. This is status observation, not a new edit. An error (for example a stale anchor) is terminal: re-read the buffer and propose a fresh exact edit.'};
        }
      } else if (request.params?.name === 'get_run_result') {
        const resultArgs = validateToolArguments(args, ['run_id'], ['run_id']);
        const runId = validateRunId(resultArgs.run_id);
        result = await sessionRestartedResult(runId, config);
        if (!result) result = await callEndpoint('result', { run_id: runId }, config);
        if (result?.run_id !== runId) throw new Error('native run result identity mismatch');
        const expectedSession = runSessionRegistryFor(config).sessionFor(runId);
        if (expectedSession && result.session_id && result.session_id !== expectedSession) throw new Error('native run session identity mismatch');
        if (['ok', 'error', 'indeterminate'].includes(result?.status))
          result = {...result, execution_origin:'native_console_capture', notebook_cache_refreshed:false};
        releaseCompletedAutoProposal(runId, result, config);
      } else if (request.params?.name === 'monitor_console_run') {
        const monitorArgs = validateToolArguments(args, ['run_id', 'observation_ms'], ['run_id']);
        const runId = validateRunId(monitorArgs.run_id);
        const observationMs = monitorArgs.observation_ms ?? config.monitorTimeoutMs ?? 30000;
        if (!Number.isSafeInteger(observationMs) || observationMs < 1000 || observationMs > 7200000) {
          throw new Error('observation_ms must be an integer from 1000 to 7200000');
        }
        let lastSnapshot;
        const monitor = await monitorConsoleRun(runId, { ...config, monitorTimeoutMs: observationMs,
          onSnapshot: async snapshot => { lastSnapshot = snapshot; await config.onSnapshot?.(snapshot); }
        });
        if (monitor.status === 'session_restarted') {
          result = monitor;
        } else {
          // Native capture is final-only after the prompt; when its in-flight slot
          // has disappeared, read the normal stored result without re-executing.
          let settled;
          if (monitor.status === 'not_running') {
            result = await sessionRestartedResult(runId, config);
            if (!result) settled = await callEndpoint('result', { run_id: runId }, config);
            if (settled) {
              if (settled.run_id !== runId) throw new Error('native run result identity mismatch');
              const expectedSession = runSessionRegistryFor(config).sessionFor(runId);
              if (expectedSession && settled.session_id && settled.session_id !== expectedSession) throw new Error('native run session identity mismatch');
              const completion = Array.isArray(settled.completion) ? settled.completion[0] : settled.completion;
              const tainted = Array.isArray(settled.tainted) ? settled.tainted[0] : settled.tainted;
              if (['ok', 'error', 'indeterminate'].includes(settled.status) && completion === 'top_level_prompt' && tainted === false && settled.console_busy === false) {
                monitor.completion_verified = true;
                releaseCompletedAutoProposal(runId, settled, config);
                const finalBytes = Array.isArray(settled.output_bytes) ? settled.output_bytes[0] : settled.output_bytes;
                const finalElapsed = Array.isArray(settled.elapsed_ms) ? settled.elapsed_ms[0] : settled.elapsed_ms;
                const settledSnapshot = {...lastSnapshot, state:'settled'};
                if (Number.isSafeInteger(finalBytes) && finalBytes >= 0) {
                  settledSnapshot.output_growth_bytes = Math.max(0, finalBytes - (lastSnapshot?.output_bytes ?? 0));
                  settledSnapshot.output_bytes = finalBytes;
                }
                if (Number.isFinite(finalElapsed) && finalElapsed >= 0) settledSnapshot.elapsed_ms = Math.floor(finalElapsed);
                try { if (lastSnapshot) void Promise.resolve(config.onSnapshot?.(settledSnapshot)).catch(() => {}); } catch { /* UI does not change execution */ }
              } else {
                result = {...monitor, status: ['unknown', 'expired'].includes(settled.status) ? settled.status : 'finalization_pending', completion_verified:false, result:settled};
              }
            }
          }
          // Never queue R-backed metadata reads behind a busy computation.
          const recovery = monitor.status === 'timed_out'
            ? { context: { status: 'unavailable_while_console_busy', message: 'R is still busy; recovery context was not read and no R code was run' } }
            : undefined;
          if (!result) {
            result = { ...monitor, ...(settled ? { result: settled } : {}), ...(recovery ? { recovery } : {}) };
          }
        }
      } else if (request.params?.name === 'get_debug_info') {
        const debugArgs = validateToolArguments(args, ['run_id', 'object_names'], ['run_id']);
        const objectNames = validateObjectNames(debugArgs.object_names);
        const values = { run_id: validateRunId(debugArgs.run_id) };
        // Identifiers cannot contain commas, so this scalar form encoding is
        // unambiguous at the independently validating native boundary.
        if (objectNames) values.object_names = objectNames.join(',');
        result = await readEndpoint('debug', values);
      } else if (request.params?.name === 'get_project_context') {
        validateToolArguments(args, [], []);
        result = await readEndpoint('project_context', {});
      } else if (request.params?.name === 'authorize_existing_derived_binding') {
        const values = validateToolArguments(args, ['name', 'kind'], ['name', 'kind']);
        const names = validateObjectNames([values.name]);
        if (!names || names.length !== 1 || names[0].startsWith('.rs.') ||
            !['plots', 'helper', 'path'].includes(values.kind))
          throw new Error('invalid derived binding name or kind');
        result = await callEndpoint('authorize_derived', { name: names[0], kind: values.kind }, config);
      } else if (request.params?.name === 'write_project_file') {
        const values = validateToolArguments(args, ['path', 'expected_digest', 'contents'], ['path', 'expected_digest', 'contents']);
        const path = validateProjectFilePath(values.path);
        if (typeof values.expected_digest !== 'string' || !/^[a-f0-9]{64}$/.test(values.expected_digest) ||
            typeof values.contents !== 'string' || Buffer.byteLength(values.contents) > MAX_CODE_FILE_TOTAL_BYTES ||
            values.contents.includes('\0') || Buffer.from(values.contents, 'utf8').toString('utf8') !== values.contents)
          throw new Error('invalid whole-file contents or expected_digest');
        result = await callEndpoint('write', {path, expected_digest: values.expected_digest, contents: values.contents}, config);
      } else if (request.params?.name === 'read_project_file') {
        const fileArgs = validateToolArguments(args, ['path', 'offset'], ['path']);
        const values = { path: validateProjectFilePath(fileArgs.path) };
        if (fileArgs.offset !== undefined) values.offset = String(validateProjectFileOffset(fileArgs.offset));
        // Re-bound every native response page. Native is the filesystem and
        // UTF-8 boundary authority; this relay only keeps malformed responses
        // from escaping its bounded MCP surface.
        const rawResult = await readEndpoint('file', values);
        if (rawResult && typeof rawResult.text === 'string' && rawResult.text.length > MAX_PROJECT_FILE_TEXT_BYTES) {
          throw new Error('native R session returned a file response exceeding the 64 KB page bound');
        }
        result = rawResult;
      } else if (request.params?.name === 'get_environment_summary') {
        const environmentArgs = validateToolArguments(args, ['object_names', 'summary_mode', 'requested_columns'], []);
        const objectNames = validateObjectNames(environmentArgs.object_names);
        const summaryMode = validateSummaryMode(environmentArgs.summary_mode);
        const requestedColumns = validateRequestedColumns(environmentArgs.requested_columns);
        if (requestedColumns && !objectNames) {
          throw new Error('requested_columns requires object_names');
        }
        // Same unambiguous scalar encoding as /debug: identifiers cannot
        // contain commas, and the native boundary re-validates every name.
        const values = {};
        if (objectNames) values.object_names = objectNames.join(',');
        if (summaryMode !== undefined) values.summary_mode = summaryMode;
        if (requestedColumns) values.requested_columns = requestedColumns.join(',');
        result = await readEndpoint('environment', values);
      } else if (request.params?.name === 'get_plot_image') {
        const plotArgs = validateToolArguments(args, ['index'], []);
        const data = await callPlotImageEndpoint(config, validatePlotIndex(plotArgs.index));
        content = [{ type: 'image', mimeType: 'image/png', data }];
      } else if (request.params?.name === 'get_plot_history') {
        validateToolArguments(args, [], []);
        result = await readEndpoint('plots', {});
      } else if (request.params?.name === 'list_notebook_outputs') {
        const values = validateToolArguments(args, ['document_id'], ['document_id']);
        result = await readEndpoint('notebook_outputs', {document_id:validateDocumentId(values.document_id)});
      } else if (request.params?.name === 'get_notebook_output_image') {
        const values = validateToolArguments(args, ['document_id','chunk_id','ordinal','expected_document_digest'], ['document_id','chunk_id','ordinal','expected_document_digest']);
        if (typeof values.chunk_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(values.chunk_id) ||
            typeof values.ordinal !== 'string' || !/^[a-f0-9]{6}$/.test(values.ordinal) ||
            typeof values.expected_document_digest !== 'string' || !/^[a-f0-9]{64}$/.test(values.expected_document_digest))
          throw new Error('invalid notebook output identifier');
        const data = await callPlotImageEndpoint(config, undefined, {
          document_id:validateDocumentId(values.document_id),chunk_id:values.chunk_id,ordinal:values.ordinal,
          expected_document_digest:values.expected_document_digest});
        content = [{type:'text',text:JSON.stringify({execution_origin:'historical_notebook_cache_not_console_run',
          source_digest:values.expected_document_digest,cache_freshness:'unverified',
          document_id:values.document_id,chunk_id:values.chunk_id,ordinal:values.ordinal})},
          {type:'image',mimeType:'image/png',data}];
      } else if (request.params?.name === 'get_viewer_state') {
        validateToolArguments(args, [], []);
        result = await readEndpoint('viewer', {});
      } else {
        throw new Error('unknown tool');
      }
      if (!content) {
        try { result = await captureAuditEvidence(request.params.name, args, result, config, auditIO, evidenceBinding); }
        catch (error) { result = {...result, audit_evidence_unavailable: error.message}; }
      }
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: { content: content ?? [{ type: 'text', text: JSON.stringify(result) }] }
      };
    }

    return { jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'method not found' } };
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) }
    };
  }
}

function main() {
  const config = { ...requireNativeConfig(), proposalIdCache: createProposalIdentityCache() };
  if (config.inspectorUrl) {
    config.onSnapshot = async (snapshot) => {
      const response = await fetch(config.inspectorUrl, {
        method: 'POST',
        signal: AbortSignal.timeout(1000),
        headers: {
          'Content-Type': 'application/json',
          'X-RAI-Bridge-Token': config.token
        },
        body: JSON.stringify(snapshot)
      });
      if (!response.ok) throw new Error(`run inspector rejected snapshot (${response.status})`);
    };
  }
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    const message = await handleRequest(request, config);
    if (message) process.stdout.write(`${JSON.stringify(message)}\n`);
  });
}

if (import.meta.main) main();
