import { peerMac as makePeerMac, peerMatches as matchPeerProof, PEER_BODY_MAX_BYTES } from './peer-proof.js';
// RAI Assistant terminal bridge — Stage 3.
// Serves a browser terminal (xterm.js) wired over a WebSocket to a REAL
// interactive `claude` TUI running inside a pty (node-pty). No stream-json,
// no chat bubbles — the browser terminal IS the terminal.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync, chmodSync, watchFile } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import { BridgeConfigError, augmentGuiPath, commandExists, createCliSession, mergeSettings, removeSessionMcpConfig, requireBridgeToken, validateProfile } from './mcp.js';
import { createCaffeinateGuard } from './caffeinate-guard.js';
import { CONFIG_DIR, CONFIG_FILE, DEFAULT_CONFIG, backfillProviderDefaults, loadConfig, writeConfig } from './config.js';
import { createSettingsAuthority } from './settings-authority.js';
import { callEndpoint, requireNativeConfig } from './rai-native-mcp.js';
import { validateSnippets } from './public/scoped-guidance.js';
import { validateGlobalPrompt } from './public/global-prompt.js';
import { skillSourceStatus } from './skill-status.js';
import { createRetainedTerminal } from './terminal-session.js';
import { ActiveModelTracker, resolveRequestedModel, settingsCatalogForActiveModels } from './model-reflection.js';
import { createWsSessionToken, validateWebSocketUpgrade } from './ws-auth.js';
import { createProviderStatusCache, grokAuthState, providerStatusForSettings } from './provider-status.js';
import { createProviderLoginSession } from './provider-login.js';
import { createRunInspectorState } from './run-inspector-state.js';

augmentGuiPath();

// rsession pipes our stdout/stderr back to itself to capture crash
// diagnostics (see onBridgeStderr in SessionRaiAssistant.cpp). This process
// is meant to outlive rsession across "Restart R" -- once rsession exits,
// that pipe's read end closes, and the next write would otherwise throw
// EPIPE and crash us right when we are supposed to keep running. Swallow it
// instead.
process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });

// "Restart R" is a full rsession process exit, and rsession's own cleanup
// (terminateAllChildren in SessionMain.cpp) unconditionally SIGTERMs every
// process it supervises, including us -- there is no supervisor-level flag
// that exempts a child from that sweep. Ignoring SIGTERM is what actually
// lets us survive it (this also keeps the claude pty's controlling process
// -- us -- alive, so claude never sees the pty hang up either). A genuine
// app quit still reaches us: session-launcher.ts's killRaiBridge() sends
// SIGKILL, which cannot be caught.
process.on('SIGTERM', () => {});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = parseInt(process.env.RAI_BRIDGE_PORT || '8790', 10);
const HOST = '127.0.0.1';
const RUN_INSPECTOR_URL = `http://${HOST}:${PORT}/internal/run-inspector`;
const RUN_INSPECTOR_BODY_MAX_BYTES = 4096;
// Workspace for newly opened Assistant sessions. The native rsession refreshes
// this through an authenticated loopback call before it gives the pane the URL.
let CWD = process.env.RAI_BRIDGE_CWD || os.homedir();

let config = loadConfig({ persistMigration: !process.env.RAI_SESSION_HEALTH_URL });
const settingsAuthority = createSettingsAuthority({
  ...(process.env.RAI_SESSION_HEALTH_URL ? { nativeCall: (name, values) =>
    callEndpoint(name, values, requireNativeConfig()) } : {})
});
let settingsRevision = null;
let canonicalSettingsReady = false;
// Serialize native reads, CAS saves and file-watch refreshes. A delayed read
// must never replace a newer acknowledged snapshot in the bridge.
let settingsQueue = Promise.resolve();
function withSettingsAuthority(operation) {
  const result = settingsQueue.then(operation);
  settingsQueue = result.catch(() => {});
  return result;
}
function normalizeSettings(value) {
  const stored = structuredClone(value);
  const settings = backfillProviderDefaults({ ...structuredClone(DEFAULT_CONFIG), ...stored,
    providers: { ...structuredClone(DEFAULT_CONFIG.providers), ...stored.providers } });
  // Effective policy is fixed; raw compatibility values still round-trip in
  // the settings authority's exact committed-byte acknowledgement.
  return { ...settings, autoApproveReadOnly: true, saveOnEdit: true };
}
// Default reads retain standalone startup/GET migration; other reads must opt out.
async function refreshCanonicalSettings(options) {
  const snapshot = await settingsAuthority.read(options);
  config = normalizeSettings(snapshot.settings);
  settingsRevision = snapshot.settings_revision;
  canonicalSettingsReady = true;
  return snapshot;
}
// Defaults are supplied by loadConfig()/DEFAULT_CONFIG. A saved false is an
// explicit user choice: bridge startup must not rewrite it or arm the live
// caffeine guard until the user turns it back on in unified Settings.
// autoApproveReadOnly is a retired compatibility value, not an effective policy switch.
const startupProfile = validateProfile(config);
if (!startupProfile.ok) console.error(`[bridge] invalid startup profile: ${startupProfile.error}`);
// Active models are session-scoped observations from provider PTY output.
// They are deliberately not persisted or inferred from CLI/API catalogs.
const activeModels = new Map();
// Browser-only credential for the local PTY WebSocket. It is generated once
// per bridge process and never forwarded into provider CLI child processes.
const wsSessionToken = createWsSessionToken();
const runInspector = createRunInspectorState({
  onChange(snapshot) { sendToClient({ type: 'run_inspector', snapshot }); }
});

function activeModelSnapshot() {
  return Object.fromEntries([...activeModels].map(([provider, value]) => [provider, value.model]));
}

// node-pty ships prebuilt binaries, but npm's tar extraction can drop the exec
// bit on the darwin spawn-helper, giving "posix_spawnp failed". Restore it.
function ensureSpawnHelper() {
  const base = path.join(__dirname, 'node_modules', 'node-pty', 'prebuilds');
  const plat = `${process.platform}-${process.arch}`;
  const helper = path.join(base, plat, 'spawn-helper');
  try {
    if (existsSync(helper) && !(statSync(helper).mode & 0o111)) {
      chmodSync(helper, 0o755);
      console.log(`[bridge] fixed exec bit on ${helper}`);
    }
  } catch (e) {
    console.error(`[bridge] could not check spawn-helper: ${e.message}`);
  }
}
ensureSpawnHelper();

// The iframe's first resize can arrive while canonical settings are pending.
// Retain its grid so the delayed PTY and subsequent restarts match the client.
let terminalSize = { cols: 120, rows: 40 };

function spawnCli() {
  const p = config.providers[config.provider];
  return createCliSession({
    provider: config.provider,
    profile: p,
    model: config.model,
    effort: config.effort,
    globalPrompt: config.globalPrompt,
    autoApprove: config.autoApproveReadOnly,
    configDir: CONFIG_DIR,
    bridgeDir: __dirname,
    cwd: CWD,
    cols: terminalSize.cols,
    rows: terminalSize.rows,
    env: { ...process.env, RAI_RUN_INSPECTOR_URL: RUN_INSPECTOR_URL },
    spawn: pty.spawn
  });
}

// ---- HTTP static ----

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript',
  '.css': 'text/css', '.map': 'application/json'
};

async function serveStatic(req, res) {
  let rel = req.url === '/' ? 'index.html' : req.url.replace(/^\/+/, '').split('?')[0];
  const file = path.join(PUBLIC, rel);
  const relFromPublic = path.relative(PUBLIC, file);
  if (relFromPublic === '..' || relFromPublic.startsWith('..' + path.sep) || path.isAbsolute(relFromPublic)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    let body = await readFile(file);
    // The token is kept in this same-origin document rather than storage or a
    // provider process. terminal.js only appends it to the local WS URL.
    if (rel === 'index.html') {
      const parentOrigin = /^http:\/\/(127\.0\.0\.1|localhost):[0-9]+$/.test(process.env.RAI_UI_PARENT_ORIGIN || '')
        ? process.env.RAI_UI_PARENT_ORIGIN : '';
      body = Buffer.from(body.toString('utf8')
        .replace('__RAI_WS_SESSION_TOKEN_VALUE__', JSON.stringify(wsSessionToken))
        .replace('__RAI_PARENT_ORIGIN_VALUE__', JSON.stringify(parentOrigin)));
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

// ---- settings API ----

function readBody(req, maxBytes = Infinity, asBuffer = false, timeoutMs) {
  return new Promise((resolve, reject) => {
    let data = asBuffer ? [] : '';
    let bytes = 0;
    let tooLarge = false;
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      tooLarge = true;
      data = '';
      const error = new Error('request body expired');
      error.code = 'REQUEST_BODY_EXPIRED';
      reject(error);
    }, timeoutMs);
    req.on('data', c => {
      if (tooLarge) return;
      bytes += Buffer.byteLength(c);
      if (bytes > maxBytes) {
        tooLarge = true;
        clearTimeout(timer);
        data = '';
        const error = new Error('request body too large');
        error.code = 'REQUEST_BODY_TOO_LARGE';
        reject(error);
        return;
      }
      if (asBuffer) data.push(Buffer.from(c)); else data += c;
    });
    req.on('end', () => {
      clearTimeout(timer);
      if (!tooLarge) resolve(asBuffer ? Buffer.concat(data) : data);
    });
    req.on('error', error => { clearTimeout(timer); reject(error); });
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj, null, 2));
}

// Browser JS receives this fresh, per-bridge token in the same-origin document
// solely to authenticate the WebSocket and local UI API. It is intentionally
// distinct from RAI_BRIDGE_TOKEN, which remains bridge/CLI-side only.
function hasValidSessionToken(req) {
  const sessionToken = req.headers['x-rai-session-token'];
  return typeof sessionToken === 'string' &&
    sessionToken.length === wsSessionToken.length &&
    timingSafeEqual(Buffer.from(sessionToken), Buffer.from(wsSessionToken));
}

async function handleSettings(req, res) {
  if (req.method === 'GET') {
    // Customized prompts may contain private research text; a foreign page
    // cannot read them just because the bridge listens on loopback.
    if (!hasValidSessionToken(req)) return res.writeHead(401).end('unauthorized');
    try {
      await refreshCanonicalSettings();
      return sendJson(res, 200, { ...settingsCatalogForActiveModels(config, activeModelSnapshot()),
        settings_revision: settingsRevision, active_provider: store.term?.__provider ?? null, provider_transition_required: Boolean(store.term && store.term.__provider !== config.provider) });
    } catch { return sendJson(res, 503, { error: 'Native settings unavailable; no fallback applied.' }); }
  }
  if (req.method === 'POST') {
    // Browser JS never holds RAI_BRIDGE_TOKEN (that stays server/CLI-side only);
    // it does hold the per-launch WS session token embedded in index.html, so
    // reuse that as this endpoint's CSRF/auth guard -- same defense ws-auth.js
    // already applies to the WebSocket upgrade, applied here to this
    // state-changing HTTP write.
    if (!hasValidSessionToken(req)) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    let body;
    try { body = JSON.parse(await readBody(req, 64 * 1024)); }
    catch (error) {
      if (error?.code === 'REQUEST_BODY_TOO_LARGE') return res.writeHead(413).end();
      return sendJson(res, 400, { error: 'invalid JSON' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return sendJson(res, 400, { error: 'invalid settings' });
    let snapshot;
    try { snapshot = await refreshCanonicalSettings({ persistMigration: false }); }
    catch { return sendJson(res, 503, { error: 'Native settings unavailable; draft retained.' }); }
    if (body.expected_revision !== settingsRevision)
      return sendJson(res, 409, { error: 'Settings changed or revision missing; reload before saving. Draft retained.' });
    let snippets;
    if (Object.hasOwn(body, 'snippets')) {
      try { snippets = validateSnippets(body.snippets, { previous: config.snippets }); }
      catch (error) { return sendJson(res, 400, { error: error.message }); }
    }
    let globalPrompt;
    if (Object.hasOwn(body, 'globalPrompt')) {
      try { globalPrompt = validateGlobalPrompt(body.globalPrompt); }
      catch (error) { return sendJson(res, 400, { error: error.message }); }
    }
    if (Object.hasOwn(body, 'autoApproveReadOnly') && typeof body.autoApproveReadOnly !== 'boolean')
      return sendJson(res, 400, { error: 'autoApproveReadOnly must be boolean' });
    if (Object.hasOwn(body, 'caffeinate') && typeof body.caffeinate !== 'boolean')
      return sendJson(res, 400, { error: 'caffeinate must be boolean' });
    if (Object.hasOwn(body, 'saveOnEdit') && typeof body.saveOnEdit !== 'boolean')
      return sendJson(res, 400, { error: 'saveOnEdit must be boolean' });
    const provider = Object.hasOwn(body, 'provider') ? body.provider : config.provider;
    if (typeof provider !== 'string' || !Object.hasOwn(config.providers, provider))
      return sendJson(res, 400, { error: 'unknown provider; no fallback applied' });
    // This settings surface launches account defaults only. Do not acknowledge
    // a model/effort selection which buildCliLaunch intentionally ignores.
    if ((Object.hasOwn(body, 'model') && body.model !== '') ||
        (Object.hasOwn(body, 'effort') && body.effort !== ''))
      return sendJson(res, 400, { error: 'Model/effort overrides are not supported here; use the provider CLI selector. Nothing saved; no fallback.' });
    const nextConfig = mergeSettings(config, body);
    // Omitted retired fields come from the authority, not the effective view.
    nextConfig.autoApproveReadOnly = typeof snapshot.settings.autoApproveReadOnly === 'boolean'
      ? snapshot.settings.autoApproveReadOnly : DEFAULT_CONFIG.autoApproveReadOnly;
    if (snippets) nextConfig.snippets = snippets;
    if (globalPrompt !== undefined) nextConfig.globalPrompt = globalPrompt;
    if (Object.hasOwn(body, 'autoApproveReadOnly')) nextConfig.autoApproveReadOnly = body.autoApproveReadOnly;
    if (Object.hasOwn(body, 'caffeinate')) nextConfig.caffeinate = body.caffeinate;
    nextConfig.saveOnEdit = true;
    if (Object.hasOwn(body, 'theme')) nextConfig.theme = body.theme;
    if (Object.hasOwn(body, 'fontSize')) nextConfig.fontSize = body.fontSize;
    const profile = validateProfile(nextConfig);
    if (!profile.ok) return sendJson(res, 400, { error: profile.error });
    try {
      const ack = await settingsAuthority.save(nextConfig, body.expected_revision);
      config = normalizeSettings(ack.settings);
      settingsRevision = ack.settings_revision;
    } catch (e) { return sendJson(res, /Settings changed/.test(e.message) ? 409 : 400, { error: e.message }); }
    if (Object.hasOwn(body, 'caffeinate')) {
      observedCaffeinate = nextConfig.caffeinate;
      setLiveCaffeinate(nextConfig.caffeinate);
    }
    // Saving never interrupts the active provider. Restart is a separate explicit action.
    sendToClient({ type: 'settings_committed', settings_revision: settingsRevision });
    return sendJson(res, 200, { ...config, settings_revision: settingsRevision,
      provider_transition_required: Boolean(store.term && store.term.__provider !== config.provider) });
  }
  res.writeHead(405).end('method not allowed');
}

async function handleProviderStatus(req, res) {
  if (req.method !== 'GET') {
    res.writeHead(405).end('method not allowed');
    return;
  }
  // This route runs provider CLI status commands. Require the same per-bridge
  // UI token as settings writes so a foreign page cannot trigger that work
  // blindly through a loopback GET.
  if (!hasValidSessionToken(req)) {
    res.writeHead(401).end('unauthorized');
    return;
  }
  // Provider CLI output can contain account details; emit fixed state labels only.
  try {
    sendJson(res, 200, { providers: await cachedProviderStatus(config) });
  } catch {
    // The bridge owns the retained provider PTY and has no unhandledRejection
    // handler; log a fixed line only, never account detail. The UI shows Unknown.
    console.error('provider status probe failed');
    sendJson(res, 503, { error: 'provider status unavailable' });
  }
}

const cachedProviderStatus = createProviderStatusCache(providerStatusForSettings);

// 64 KiB covers the native cwd JSON, including PATH_MAX x4 UTF-8 bytes
const WORKSPACE_BODY_MAX_BYTES = PEER_BODY_MAX_BYTES;
const peerChallenges = new Map();
function peerMac(label, nn, nb, body = '') {
  const port = server.address().port;
  return makePeerMac(requireBridgeToken(), label, nn, nb, port, body);
}
function peerMatches(actual, expected) {
  return matchPeerProof(actual, expected);
}
async function handlePeerChallenge(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req, 1024)); }
  catch { sendJson(res, 400, { error: 'invalid challenge' }); return; }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2 ||
      body.v !== 1 || typeof body.nn !== 'string' || !/^[0-9a-f]{64}$/.test(body.nn)) {
    sendJson(res, 400, { error: 'invalid challenge' }); return;
  }
  const now = Date.now();
  for (const [nonce, entry] of peerChallenges) if (entry.expires <= now) peerChallenges.delete(nonce);
  while (peerChallenges.size >= 16) peerChallenges.delete(peerChallenges.keys().next().value);
  const nb = randomBytes(32).toString('hex');
  const proof = peerMac('bridge-proof', body.nn, nb);
  peerChallenges.set(nb, { nn: body.nn, expires: now + 5000 });
  sendJson(res, 200, { nb, proof });
}
async function handleWorkspace(req, res) {
  const nb = req.headers['x-rai-peer-nonce'];
  const challenge = peerChallenges.get(nb);
  // Consume before any asynchronous body read or verification
  peerChallenges.delete(nb);
  if (req.headers['x-rai-bridge-token'] !== undefined || !challenge || challenge.expires <= Date.now()) {
    res.writeHead(401).end('unauthorized'); return;
  }
  let raw;
  try { raw = await readBody(req, WORKSPACE_BODY_MAX_BYTES, true, challenge.expires - Date.now()); }
  catch (error) {
    if (error?.code === 'REQUEST_BODY_TOO_LARGE' || error?.code === 'REQUEST_BODY_EXPIRED') {
      res.writeHead(error.code === 'REQUEST_BODY_TOO_LARGE' ? 413 : 401);
      res.end(() => req.destroy());
      return;
    }
    sendJson(res, 400, { error: 'invalid body' }); return;
  }
  if (challenge.expires <= Date.now() ||
      !peerMatches(req.headers['x-rai-peer-proof'], peerMac('native-proof', challenge.nn, nb, raw))) {
    res.writeHead(401).end('unauthorized'); return;
  }
  let body;
  try { body = JSON.parse(raw); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 ||
      typeof body.cwd !== 'string' || !path.isAbsolute(body.cwd)) {
    sendJson(res, 400, { error: 'cwd must be an absolute directory path' }); return;
  }
  const cwd = path.resolve(body.cwd);
  try {
    if (!statSync(cwd).isDirectory()) throw new Error('not a directory');
  } catch {
    sendJson(res, 400, { error: 'cwd must be an existing directory' }); return;
  }
  CWD = cwd;
  sendJson(res, 200, { ack: peerMac('bridge-ack', challenge.nn, nb, raw) });
}

async function handleRunInspector(req, res) {
  const token = req.headers['x-rai-bridge-token'];
  let expected;
  try { expected = requireBridgeToken(); } catch { res.writeHead(401).end('unauthorized'); return; }
  if (typeof token !== 'string' || token.length !== expected.length ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    res.writeHead(401).end('unauthorized');
    return;
  }

  let body;
  try { body = JSON.parse(await readBody(req, RUN_INSPECTOR_BODY_MAX_BYTES)); }
  catch (error) {
    if (error?.code === 'REQUEST_BODY_TOO_LARGE') { res.writeHead(413).end(); return; }
    sendJson(res, 400, { error: 'invalid run inspector snapshot' });
    return;
  }
  try { runInspector.update(body); }
  catch (error) { sendJson(res, 400, { error: error.message }); return; }
  res.writeHead(204).end();
}

// DNS rebinding guard: GET / embeds the session token, so only loopback names may reach any route.
const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
function hasAllowedHost(req) {
  const match = /^(\[[0-9a-f:]+\]|[^:\[\]@\s]+)(?::[0-9]{1,5})?$/i.exec(req.headers.host || '');
  return match !== null && ALLOWED_HOSTNAMES.has(match[1].toLowerCase());
}

const server = http.createServer(async (req, res) => {
  if (!hasAllowedHost(req)) return res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden host');
  const url = req.url.split('?')[0];
  if (url === '/internal/run-inspector' && req.method === 'POST') return handleRunInspector(req, res);
  if (url === '/api/peer-challenge' && req.method === 'POST') return handlePeerChallenge(req, res);
  if (url === '/api/workspace' && req.method === 'POST') return handleWorkspace(req, res);
  if (url === '/api/settings') return withSettingsAuthority(() => handleSettings(req, res));
  if (url === '/api/skill-status' && req.method === 'GET') {
    if (!hasValidSessionToken(req)) return res.writeHead(401).end('unauthorized');
    if (req.url.length > 256) return res.writeHead(414).end();
    try {
      const name = new URL(req.url, `http://${HOST}:${PORT}`).searchParams.get('name');
      return sendJson(res, 200, skillSourceStatus(config.provider, name, { cwd: CWD, bridgeDir: __dirname }));
    } catch (error) { return sendJson(res, 400, { error: error.message }); }
  }
  if (url === '/api/provider-status') return handleProviderStatus(req, res);
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405).end('method not allowed');
});

// ---- WebSocket pty ----
// One fresh pty per connection (lazy). Protocol:
//   client -> server: JSON text frames {type:"input",data} | {type:"resize",cols,rows}
//   server -> client: raw pty output as BINARY frames; control as JSON text frames
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const origin = `http://${HOST}:${PORT}`;
  const authorization = hasAllowedHost(req)
    ? validateWebSocketUpgrade(req, { token: wsSessionToken, origin })
    : { ok: false, status: 403, error: 'Forbidden' };
  if (!authorization.ok) {
    socket.write(`HTTP/1.1 ${authorization.status} ${authorization.error}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

// Debounce window for the busy/idle heuristic: no pty output for this long
// means the CLI has settled back at its own prompt. See wireTerm() below.
const IDLE_DEBOUNCE_MS = 1000;
// Recent pty output kept for replay when a client reconnects. Bounded so a
// long conversation can never grow this without limit.
const OUTPUT_BUFFER_LIMIT = 512 * 1024;
// How long a retained pty waits for a client to (re)attach before it is
// reaped. An "Restart R" iframe reload reconnects in a second or two, well
// within this window; a real app quit SIGKILLs the whole bridge, so this timer
// never fires there. Bounded so a permanently-closed pane cannot orphan a
// provider process forever.
const NO_CLIENT_GRACE_MS = parseInt(process.env.RAI_BRIDGE_NO_CLIENT_GRACE_MS || '60000', 10);

// The provider pty is retained here, at the bridge level, rather than owned by
// a single browser WebSocket. "Restart R" closes the iframe's WebSocket but
// leaves this bridge running (see the SIGTERM note above); keeping the pty
// attached to the bridge -- not the socket -- is what lets the SAME claude or
// codex conversation survive the reload instead of being killed and respawned.
const store = createRetainedTerminal({
  bufferLimit: OUTPUT_BUFFER_LIMIT,
  graceMs: NO_CLIENT_GRACE_MS,
  idleMs: IDLE_DEBOUNCE_MS,
  onReap(t) {
    stopTerm(t);
    console.log(`[bridge] pty ${t.pid} reaped (no client for ${NO_CLIENT_GRACE_MS}ms)`);
  }
});

function sendToClient(obj) {
  const ws = store.client;
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function sendStatus(state) {
  const ws = store.client;
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'status', state }));
}

function stopCaffeinateGuard(t) {
  if (!t?.__caffeinateGuard) return;
  try { t.__caffeinateGuard.kill(); } catch {}
  t.__caffeinateGuard = null;
}

function armCaffeinateGuard(t) {
  if (!t || t.__caffeinateGuard || t.__signingIn || t.__closing || config.caffeinate === false) return;
  const guard = createCaffeinateGuard({ pid: t.pid, enabled: true });
  if (!guard) return;
  config.caffeinateStartedAt = Date.now();
  // Runtime lease metadata is not a competing settings-file write.
  t.__caffeinateGuard = guard;
  // `-t` ends after the bounded lease. Re-arm the independent assertion while
  // the same live CLI remains active; the assistant itself is never restarted.
  guard?.once?.('exit', () => {
    if (t.__caffeinateGuard !== guard) return;
    t.__caffeinateGuard = null;
    if (store.term === t && !t.__signingIn && !t.__closing && config.caffeinate !== false)
      setTimeout(() => armCaffeinateGuard(t), 1000);
  });
}

function setLiveCaffeinate(enabled) {
  config.caffeinate = enabled;
  const t = store.term;
  if (!t || t.__signingIn || t.__closing) return;
  if (!enabled) {
    stopCaffeinateGuard(t);
    return;
  }
  armCaffeinateGuard(t);
}

// The native checkbox RPC writes ~/.raistudio/assistant.json directly. Watch
// that persisted setting so changing the checkbox changes the active CLI's
// display-sleep assertion without restarting or interrupting the session.
let observedCaffeinate = config.caffeinate !== false;
watchFile(CONFIG_FILE, { interval: 250, persistent: false }, () => {
  void withSettingsAuthority(async () => {
    try {
      await refreshCanonicalSettings({ persistMigration: false });
      const next = config.caffeinate !== false;
      if (next !== observedCaffeinate) { observedCaffeinate = next; setLiveCaffeinate(next); }
    } catch { /* No local fallback writer on native failure. */ }
  });
});

function removeTermConfig(t) {
  if (t?.__mcpConfigPath) {
    try { removeSessionMcpConfig(t.__mcpConfigPath, { configDir: CONFIG_DIR }); } catch (e) {
      console.error(`[bridge] could not remove MCP session config: ${e.message}`);
    }
    t.__mcpConfigPath = null;
  }
}

// Pending input belongs to one startup attempt and one WebSocket only.
const INPUT_QUEUE_BYTES = 1024 * 1024;
const INPUT_QUEUE_FRAMES = 1024;
let pendingInput = null;
// First output is a readiness hint; silent/login children must still accept input
const INPUT_READY_DEADLINE_MS = 1000;

function clearPendingInput() {
  if (pendingInput) { pendingInput.frames.length = 0; pendingInput.bytes = 0; }
  pendingInput = null;
}

function writeInput(term, data) {
  term.__modelTracker?.noteInput(data);
  term.write(data);
}

function flushPendingInput(term) {
  const pending = pendingInput;
  pendingInput = null;
  if (!pending || pending.ws !== store.client || pending.ws.readyState !== pending.ws.OPEN) return;
  for (const data of pending.frames) writeInput(term, data);
}

function requestSession(ws, { signingIn = false, restarting = false, refreshSettings = false } = {}) {
  clearPendingInput();
  const pending = { ws, frames: [], bytes: 0 };
  pendingInput = pending;
  const launch = () => {
    if (pendingInput !== pending || store.client !== ws || ws.readyState !== ws.OPEN) return;
    if (!(signingIn ? startSignIn() : start())) clearPendingInput();
    else if (restarting) sendToClient({ type: 'restarted' });
  };
  if (canonicalSettingsReady && !refreshSettings) launch();
  else void withSettingsAuthority(async () => {
    if (pendingInput !== pending) return;
    try { await refreshCanonicalSettings({ persistMigration: false }); launch(); }
    catch {
      if (pendingInput !== pending) return;
      clearPendingInput();
      sendToClient({type:'bridge_config_error',error:'Native settings unavailable; no provider started.'});
    }
  });
}

function stopTerm(t, { restarting = false } = {}) {
  clearPendingInput();
  if (!t) return;
  clearTimeout(t.__inputReadyTimer);
  t.__restarting = restarting;
  t.__closing = !restarting;
  try { t.kill(); } catch {}
  stopCaffeinateGuard(t);
  removeTermConfig(t);
  store.stopActivity();
}

function wireTerm(t) {
  t.__inputReady = false;
  const ready = () => {
    if (store.term !== t || t.__inputReady) return;
    t.__inputReady = true;
    clearTimeout(t.__inputReadyTimer);
    flushPendingInput(t);
  };
  t.__inputReadyTimer = setTimeout(ready, INPUT_READY_DEADLINE_MS);
  try { t.resize(terminalSize.cols, terminalSize.rows); } catch {}
  t.__provider = config.provider;
  t.__modelTracker = new ActiveModelTracker(t.__provider);
  t.onData(data => {
    // A pty we have already replaced (killed on restart/sign-in/reap) can emit
    // one last flush before its exit lands. Ignore it so stale bytes never
    // reach the current client or the replay buffer.
    if (store.term !== t) return;
    ready();
    const activeModel = t.__modelTracker.observe(data);
    if (activeModel) {
      activeModels.set(t.__provider, { model: activeModel, term: t });
      sendToClient({ type: 'active_model', provider: t.__provider, model: activeModel });
    }
    store.appendOutput(data);
    const ws = store.client;
    if (ws && ws.readyState === ws.OPEN) ws.send(data); // Buffer -> binary frame
    store.noteActivity(sendStatus);
  });
  t.onExit(({ exitCode, signal }) => {
    clearTimeout(t.__inputReadyTimer);
    // Only a still-current pty owns the shared session state (the retained term
    // and its reap timer). A stale pty we already replaced must not clear the
    // new pty's armed reap -- that would leave the new one orphaned.
    if (store.term === t) {
      clearPendingInput();
      store.term = null;
      store.cancelReap();
    }
    if (activeModels.get(t.__provider)?.term === t) activeModels.delete(t.__provider);
    removeTermConfig(t);
    if (t.__signingIn) {
      if (t.__closing || t.__restarting) return;
      sendToClient({ type: 'signin_complete' });
      start(); // restore the normal assistant terminal
      return;
    }
    if (t.__restarting) return; // intentional restart; don't signal exit
    if (t.__closing) return;
    console.log(`[bridge] pty ${t.pid} exited code=${exitCode} signal=${signal}`);
    sendToClient({ type: 'exit', exitCode, signal });
  });
}

function start() {
  const profile = validateProfile(config);
  if (!profile.ok) {
    sendToClient({ type: 'profile_error', error: profile.error });
    return false;
  }
  try {
    requireBridgeToken();
  } catch (e) {
    sendToClient({ type: 'bridge_config_error', error: e.message });
    return false;
  }
  const provider = config.providers[config.provider];
  if (!commandExists(provider.command)) {
    sendToClient({ type: 'launch_failed', provider: config.provider, command: provider.command });
    return false;
  }
  let spawned;
  let launchNotice;
  try {
    const session = spawnCli();
    launchNotice = session.notice;
    spawned = session.term;
    spawned.__mcpConfigPath = session.configPath;
    armCaffeinateGuard(spawned);
  } catch (e) {
    console.error(`[bridge] could not spawn ${provider.command}: ${e.message}`);
    if (e instanceof BridgeConfigError) sendToClient({ type: 'bridge_config_error', error: e.message });
    else sendToClient({ type: 'launch_failed', provider: config.provider, command: provider.command });
    return false;
  }
  store.clearOutput(); // fresh conversation -- nothing prior to replay
  store.term = spawned;
  console.log(`[bridge] pty ${spawned.pid} spawned: ${config.provider}/${config.model} (cwd ${CWD})`);
  wireTerm(spawned);
  if (launchNotice) {
    const data = Buffer.from(`\r\n[RAI] ${launchNotice}\r\n`);
    store.appendOutput(data);
    const ws = store.client;
    if (ws && ws.readyState === ws.OPEN) ws.send(data);
  }
  return true;
}

function startSignIn() {
  const profile = validateProfile(config);
  const provider = config.providers[config.provider];
  if (!profile.ok || !provider || provider.authMode === 'api' || !commandExists(provider.command)) {
    sendToClient({ type: 'signin_unavailable' });
    return false;
  }
  // `grok login` replaces the Terminal.app session. An existing account opens
  // the same authenticated CLI the other providers reuse.
  const alreadySignedIn = config.provider === 'grok' && grokAuthState() === 'authenticated';

  const oldTerm = store.term;
  store.term = null;
  runInspector.reset();
  const pending = pendingInput;
  pendingInput = null;
  stopTerm(oldTerm, { restarting: true });
  pendingInput = pending;
  if (alreadySignedIn) {
    sendToClient({ type: 'already_signed_in' });
    return start();
  }
  try {
    const loginTerm = createProviderLoginSession({
      provider: config.provider,
      profile: provider,
      cwd: CWD,
      spawn: pty.spawn
    });
    loginTerm.__signingIn = true;
    store.clearOutput();
    store.term = loginTerm;
    wireTerm(loginTerm);
    sendToClient({ type: 'signin_started' });
    return true;
  } catch (e) {
    store.term = null;
    console.error(`[bridge] could not start ${config.provider} sign-in: ${e.message}`);
    sendToClient({ type: 'signin_unavailable' });
    clearPendingInput();
    start(); // restore the normal assistant terminal
    return false;
  }
}

wss.on('connection', ws => {
  // Exactly one client is attached at a time. A reconnecting iframe (the fresh
  // pane RStudio loads after "Restart R", or the client's own reconnect timer)
  // replaces any previous client and re-attaches to the retained pty -- it does
  // not spawn a second conversation.
  clearPendingInput();
  terminalSize = { cols: 120, rows: 40 };
  const previous = store.attach(ws);
  if (previous) { try { previous.close(); } catch {} }
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'run_inspector', snapshot: runInspector.get() }));

  if (store.term) {
    // Reattach to the surviving conversation: replay the recent output so the
    // terminal is repopulated, then report the current activity state. The CLI
    // also repaints itself when the reconnecting client sends its resize.
    const backlog = store.snapshotOutput();
    if (backlog && ws.readyState === ws.OPEN) {
      // 'replay_start' tells the client to reset its terminal before the
      // backlog lands, so the retained output is reconstructed exactly once --
      // a fresh post-Restart-R iframe starts empty, but the client's own
      // auto-reconnect keeps its old contents and would otherwise duplicate.
      ws.send(JSON.stringify({ type: 'replay_start' }));
      ws.send(backlog);
    }
    sendStatus(store.busy ? 'busy' : 'idle');
  } else {
    requestSession(ws, { refreshSettings: true });
  }

  ws.on('message', raw => {
    if (store.client !== ws || ws.readyState !== ws.OPEN) return;
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    const term = store.term;
    if (msg.type === 'input' && typeof msg.data === 'string') {
      if (term && term.__inputReady !== false) writeInput(term, msg.data);
      else if (pendingInput?.ws === ws || term?.__inputReady === false) {
        if (!pendingInput) pendingInput = { ws, frames: [], bytes: 0 };
        const bytes = Buffer.byteLength(msg.data);
        if (pendingInput.bytes + bytes > INPUT_QUEUE_BYTES || pendingInput.frames.length >= INPUT_QUEUE_FRAMES) {
          clearPendingInput();
          ws.close(1009, 'Pending input queue limit exceeded');
          return;
        }
        pendingInput.frames.push(msg.data);
        pendingInput.bytes += bytes;
      } else {
        ws.close(1013, 'No terminal session accepting input; restart required');
      }
    } else if (msg.type === 'resize') {
      if (store.client !== ws) return;
      const cols = Math.max(1, msg.cols | 0);
      const rows = Math.max(1, msg.rows | 0);
      terminalSize = { cols, rows };
      try { term?.resize(cols, rows); } catch {}
    } else if (msg.type === 'restart' || msg.type === 'stop') {
      const oldTerm = store.term;
      store.term = null;
      runInspector.reset();
      stopTerm(oldTerm, { restarting: true });
      if (msg.type === 'restart') {
        requestSession(ws, { restarting: true });
      }
    } else if (msg.type === 'sign_in') {
      clearPendingInput();
      requestSession(ws, { signingIn: true });
    }
  });

  // The client detaches but the pty stays alive, retained by the bridge, until
  // a client reattaches or the no-client grace elapses and it is reaped. This
  // is the fix for the "Restart R" regression: closing the socket no longer
  // kills the conversation.
  const detach = () => {
    if (store.client === ws) clearPendingInput();
    store.detach(ws);
  };
  ws.on('close', detach);
  ws.on('error', detach);
});

server.listen(PORT, HOST, () => {
  console.log(`[bridge] listening on http://${HOST}:${PORT}  (provider: ${config.provider})`);
  void withSettingsAuthority(() => refreshCanonicalSettings())
    .catch(error => console.error(`[bridge] startup settings read failed: ${error.message}`));
});
