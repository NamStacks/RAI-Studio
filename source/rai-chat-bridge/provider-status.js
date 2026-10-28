import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { commandExists, resolveBinary } from './mcp.js';

const STATUS_OPTIONS = Object.freeze({
  encoding: 'utf8',
  timeout: 5000,
  maxBuffer: 16 * 1024,
  windowsHide: true
});

const AUTH_STATUS_COMMANDS = Object.freeze({
  claude: ['auth', 'status'],
  codex: ['login', 'status']
  // OpenCode has no documented non-interactive status subcommand with a
  // reliable exit code, so it is checked via its own credential file
  // instead (see opencodeAuthState below) rather than guessing from a CLI
  // exit code.
});

// OpenCode persists successful `opencode auth login` here as a JSON object
// keyed by provider id (e.g. {"openai": {...}}). Never read its contents
// beyond "is this valid non-empty JSON with at least one entry" -- the
// actual token/provider details must never leave this process.
function opencodeAuthFilePath() {
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
}

function opencodeAuthState({ exists = existsSync, readFile = readFileSync } = {}) {
  const authFile = opencodeAuthFilePath();
  if (!exists(authFile)) return 'unauthenticated';
  try {
    const parsed = JSON.parse(readFile(authFile, 'utf8'));
    return parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0
      ? 'authenticated'
      : 'unauthenticated';
  } catch {
    return 'unknown';
  }
}

// Grok stores the Terminal.app login in ~/.grok/auth.json. An account object
// is enough. The token, email, and refresh secret never leave this process.
function grokAuthFilePath() {
  return path.join(os.homedir(), '.grok', 'auth.json');
}

export function grokAuthState({ exists = existsSync, readFile = readFileSync } = {}) {
  const authFile = grokAuthFilePath();
  if (!exists(authFile)) return 'unauthenticated';
  try {
    const parsed = JSON.parse(readFile(authFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unauthenticated';
    const signedIn = Object.values(parsed).some(account =>
      account && typeof account === 'object' && !Array.isArray(account) &&
      typeof account.auth_mode === 'string' && account.auth_mode.length > 0);
    return signedIn ? 'authenticated' : 'unauthenticated';
  } catch {
    return 'unknown';
  }
}

// Returns only fixed state labels; stdout/stderr from provider CLIs is never
// returned so an OAuth token, email address, or diagnostic stays local.
export function runStatus(command, args, options, { resolve: resolveCommand = resolveBinary } = {}) {
  // Account probes must not stall native Settings transactions or PTY traffic.
  // Keep the same subprocess bounds; discard all account output locally.
  // A GUI-launched app has no ~/.local/bin or Homebrew on PATH, so run the
  // resolved binary and keep its directory and bundled node on the child PATH.
  const binary = resolveCommand(command);
  const dirs = [path.dirname(binary), path.dirname(process.execPath)].filter(dir => dir !== '.');
  const env = { ...process.env, PATH: [...dirs, process.env.PATH].filter(Boolean).join(path.delimiter) };
  // Provider processes must never see the bridge or owner tokens (see buildCliLaunch).
  for (const name of ['RAI_BRIDGE_TOKEN', 'RAI_OWNER_TOKEN', 'RAI_RUN_INSPECTOR_URL', 'RAI_BRIDGE_TOKEN_FILE']) delete env[name];
  return new Promise(resolve => execFile(binary, args, { ...options, env }, error => {
    // Only a real exit code answers "signed in?"; spawn failures and timeouts do not.
    resolve({ status: !error ? 0 : typeof error.code === 'number' ? error.code : null });
  }));
}

export async function providerStatusForSettings(config, {
  commandExists: isCommandAvailable = commandExists,
  run = runStatus,
  fileExists = existsSync,
  readFile = readFileSync
} = {}) {
  const statuses = {};
  for (const [key, provider] of Object.entries(config.providers || {})) {
    const authMode = provider?.authMode === 'api' ? 'api' : 'subscription';
    const commandAvailable = typeof provider?.command === 'string' && isCommandAvailable(provider.command);
    let authState = 'unavailable';

    if (commandAvailable && authMode === 'api') {
      // API credentials stay in the provider CLI's environment/configuration;
      // this loopback endpoint deliberately neither reads nor reports them.
      authState = 'api-configured';
    } else if (commandAvailable && key === 'opencode') {
      authState = opencodeAuthState({ exists: fileExists, readFile });
    } else if (commandAvailable && key === 'grok') {
      authState = grokAuthState({ exists: fileExists, readFile });
    } else if (commandAvailable) {
      const args = AUTH_STATUS_COMMANDS[key];
      if (!args) authState = 'unknown';
      else {
        try {
          const { status } = await run(provider.command, args, STATUS_OPTIONS);
          authState = status === 0 ? 'authenticated'
            : status === null || status === 126 || status === 127 ? 'unknown'
            : 'unauthenticated';
        } catch {
          authState = 'unknown';
        }
      }
    }

    statuses[key] = { commandAvailable, authState, authMode };
  }
  return statuses;
}

// A probe that never settles must not pin its entry forever: providers x the
// 5 s CLI timeout, plus slack. Past this age the next request starts a fresh probe.
export const INFLIGHT_MAX_MS = 12000;

// Concurrent requests share one in-flight probe; a finished result is reused for
// ttlMs only when every provider is in a definite state (an "unknown" from a
// timeout or spawn failure is shared by the callers already waiting, then
// dropped). The key covers every field the probe reads, so a Settings change of
// a provider command or auth mode starts a fresh probe. Rejections are not cached.
// The default clock is monotonic so a wall-clock jump cannot stretch or cut the TTL.
export function createProviderStatusCache(load, { ttlMs = 2000, now = () => performance.now() } = {}) {
  let entry = null;
  return function cachedStatus(config) {
    const key = JSON.stringify(Object.entries(config.providers || {})
      .map(([name, provider]) => [name, provider?.command, provider?.authMode]));
    const time = now();
    if (entry && entry.key === key &&
        (entry.expires === null ? time - entry.started < INFLIGHT_MAX_MS : entry.expires > time)) return entry.promise;
    const mine = { key, started: time, expires: null };
    mine.promise = load(config).then(result => {
      // An abandoned probe that settles late must not touch the fresh entry.
      if (entry !== mine) return result;
      if (Object.values(result || {}).some(status => status?.authState === 'unknown')) entry = null;
      else mine.expires = now() + ttlMs;
      return result;
    }, error => { if (entry === mine) entry = null; throw error; });
    entry = mine;
    return mine.promise;
  };
}
