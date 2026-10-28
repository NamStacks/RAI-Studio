import { chmodSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { renderSessionInstructions } from './rai-audit-mcp.js';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { resolveEffortInput } from './public/effort.js';
// Importing this module is free of consequence -- it has no top-level side
// effects and attaches no stdin handler (pinned by its own test).
import { cliAllowedToolNames } from './rai-native-mcp.js';
import { composeAssistantInstructions, validateGlobalPrompt } from './public/global-prompt.js';

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RAI_ASSISTANT_SKILL = path.join(BRIDGE_DIR, 'prompts', 'RAI-Assistant.md');
// Claude Code loads this local plugin only for the launched session. Its
// SKILL.md registers /rai-audit without writing ~/.claude or .claude/.
const RAI_AUDIT_PLUGIN_DIR = path.join(BRIDGE_DIR, 'skills', 'rai-audit');
// A user-level rai-audit skill already registers /rai-audit; loading the
// bundled plugin too would list a second copy as /rai-audit:rai-audit.
function userAuditSkillExists(env) {
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
  return existsSync(path.join(claudeDir, 'skills', 'rai-audit', 'SKILL.md'));
}
// Matches Claude's mcp-config.json, Codex's wrapper.sh, and OpenCode's
// session-scoped opencode.json session artifacts.
const SESSION_CONFIG = /^mcp-(\d+)-[A-Za-z0-9-]+\.(?:json|sh)(?:\.instructions\.md|\.token)?(?:\.tmp)?$/;

function sessionInstructionsPath(configPath) { return `${configPath}.instructions.md`; }
function writeSessionInstructions(configPath, globalPrompt, serverName) {
  validateGlobalPrompt(globalPrompt);
  if (!globalPrompt && !serverName) return RAI_ASSISTANT_SKILL;
  const target = sessionInstructionsPath(configPath);
  const base = renderSessionInstructions(readFileSync(RAI_ASSISTANT_SKILL, 'utf8'), serverName || 'rai');
  const fd = openSync(target, 'wx', 0o600);
  try {
    try { writeFileSync(fd, composeAssistantInstructions(base, globalPrompt)); }
    finally { closeSync(fd); }
  } catch (error) {
    try { unlinkSync(target); } catch { /* Only this exclusive creation is ours. */ }
    throw error;
  }
  return target;
}

export class BridgeConfigError extends Error {
  constructor(message = 'RAI_BRIDGE_TOKEN is required to start the RAI MCP bridge') {
    super(message);
    this.name = 'BridgeConfigError';
  }
}

// nvm installs each Node version under its own versions/node/<version>/bin/
// directory and never touches PATH directly -- only the shell rc's `nvm use`
// / auto-switch logic does, which a GUI-launched app never runs. A global
// `npm install -g` under nvm lands here, not in any fixed prefix above.
// Check newest-first so a stale older Node version's install doesn't shadow
// a real one in the currently-active version.
function findInNvmVersions(name) {
  const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
  let versions;
  try {
    versions = readdirSync(nvmDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return undefined;
  }
  for (const version of versions) {
    const candidate = path.join(nvmDir, version, 'bin', name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function findBinary(name) {
  if (typeof name !== 'string' || name.length === 0) return;
  if (path.isAbsolute(name)) return existsSync(name) ? name : undefined;

  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (dir && existsSync(candidate)) return candidate;
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', name),
    // OpenCode's official install script (curl -fsSL https://opencode.ai/install | bash)
    // places the binary here; it is not on PATH unless the user's shell rc sources it,
    // and a GUI-launched app's PATH never picks up shell rc changes anyway.
    path.join(home, '.opencode', 'bin', name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    // npm/bun global installs (npm install -g / bun install -g) already land in
    // one of the prefixes above on a Homebrew-managed Node; ~/.npm-global only
    // applies if the user set a custom npm prefix.
    path.join(home, '.npm-global', 'bin', name),
    path.join(home, '.bun', 'bin', name),
    // pnpm's global bin (pnpm install -g): macOS default, then the Linux/XDG
    // default used when PNPM_HOME is unset.
    path.join(home, 'Library', 'pnpm', name),
    path.join(home, '.local', 'share', 'pnpm', name),
    // yarn global bin (yarn global add): classic Yarn 1.x location, then the
    // Berry/global-folder fallback.
    path.join(home, '.yarn', 'bin', name),
    path.join(home, '.config', 'yarn', 'global', 'node_modules', '.bin', name),
    // Volta's shim directory (volta install / a Volta-pinned npm install -g).
    path.join(home, '.volta', 'bin', name),
    // Arch Linux packages (pacman -S opencode / paru -S opencode-bin) install
    // to the standard system bin, already covered by the PATH scan above on
    // most setups, but included here in case PATH was stripped entirely.
    `/usr/bin/${name}`
  ];
  return candidates.find(existsSync) || findInNvmVersions(name);
}

export function resolveBinary(name) {
  return findBinary(name) || name;
}

export function commandExists(name) {
  return Boolean(findBinary(name));
}

// A GUI-launched app inherits a minimal PATH with no Homebrew, nvm or
// ~/.local/bin, so an npm-installed CLI (`#!/usr/bin/env node`, such as
// Codex) exits 127 and `claude auth status` cannot be found. Run once at
// bridge startup: inherited entries keep their order and priority, and the
// well-known install directories plus the bundled node are appended.
export function augmentGuiPath(env = process.env) {
  const home = os.homedir();
  const nvmNode = findInNvmVersions('node');
  const extra = [
    path.join(home, '.local', 'bin'), path.join(home, '.opencode', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin',
    path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.volta', 'bin'),
    ...(nvmNode ? [path.dirname(nvmNode)] : []),
    path.dirname(process.execPath)
  ].filter(existsSync);
  const inherited = (env.PATH || '').split(path.delimiter).filter(Boolean);
  env.PATH = [...new Set([...inherited, ...extra])].join(path.delimiter);
  return env;
}

export function requireBridgeToken(env = process.env) {
  const token = env.RAI_BRIDGE_TOKEN;
  if (typeof token !== 'string' || token.length === 0) throw new BridgeConfigError();
  return token;
}

function validateInspectorUrl(value) {
  if (value === undefined) return undefined;
  let url;
  try { url = new URL(value); } catch { throw new BridgeConfigError('RAI_RUN_INSPECTOR_URL must be a loopback URL'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      url.pathname !== '/internal/run-inspector' || url.username || url.password || url.search || url.hash) {
    throw new BridgeConfigError('RAI_RUN_INSPECTOR_URL must be a loopback URL');
  }
  return url.href;
}

// For Codex, configPath is the owner-only per-session wrapper script (see
// createSessionCodexWrapper) that itself holds RAI_BRIDGE_TOKEN and execs
// the native Node MCP adapter -- so the token never reaches
// Codex's own command line or config.
//
// OpenCode uses an additive inline rai overlay without replacing native config discovery.
// Claude adds its session MCP configuration to native discovery.
function tomlString(value) {
  return JSON.stringify(String(value)).replace(/\x7f/g, '\\u007f');
}

export function buildMcpArgs(provider, configPath, _autoApprove, serverName = 'rai') {
  if (provider === 'claude') return ['--mcp-config', configPath];
  if (provider === 'codex') {
    return [
      '-c', `mcp_servers.${serverName}.command=${tomlString(configPath)}`,
      '-c', `mcp_servers.${serverName}.args=[]`,
      '-c', `mcp_servers.${serverName}.env.RAI_MCP_SERVER_NAME=${tomlString(serverName)}`,
      // Native owns exact approvals. Avoid Codex's redundant prompt only for
      // these declared tools, not other servers, shell tools, or global policy.
      ...cliAllowedToolNames().flatMap(name => ['-c',
        `mcp_servers.${serverName}.tools.${name.replace('mcp__rai__', '')}.approval_mode=${tomlString('approve')}`])
    ];
  }
  return [];
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Grok session folders live under <configDir>/grok-sessions/<project hash>/.
// Each project hash folder is a repository root to Grok, so one trust decision
// covers that project's sessions and nothing else (permission grants and
// memory are keyed to the same root). Only the bridge writes there.
const GROK_SESSIONS_DIR = 'grok-sessions';
// A Terminal.app launch outlives the generator process whose pid names its
// folder, so a dead pid alone does not prove a Grok session folder is stale.
const GROK_STALE_MS = 24 * 60 * 60 * 1000;
const GROK_PLANTED_CONFIG = ['.grok', '.claude', '.cursor', '.mcp.json', 'AGENTS.md', 'CLAUDE.md'];

function removeStaleSessionConfigs(configDir) {
  for (const entry of readdirSync(configDir, { withFileTypes: true })) {
    const match = entry.name.match(SESSION_CONFIG) || (entry.isDirectory() && entry.name.replace(/\.session$/, '').match(SESSION_CONFIG));
    if (match && !isProcessAlive(Number(match[1]))) {
      // One undeletable leftover must not block every provider launch.
      try { rmSync(path.join(configDir, entry.name), { recursive: true, force: true }); } catch { /* retried on the next launch */ }
    }
  }
  removeStaleGrokSessions(configDir);
}

function removeStaleGrokSessions(configDir) {
  const root = path.join(configDir, GROK_SESSIONS_DIR);
  try {
    if (!lstatSync(root).isDirectory()) return;
    for (const project of readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const projectRoot = path.join(root, project.name);
      for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
        const match = entry.isDirectory() && entry.name.replace(/\.session$/, '').match(SESSION_CONFIG);
        if (!match || isProcessAlive(Number(match[1]))) continue;
        const folder = path.join(projectRoot, entry.name);
        if (Date.now() - lstatSync(folder).mtimeMs < GROK_STALE_MS) continue;
        rmSync(folder, { recursive: true, force: true });
      }
    }
  } catch { /* best effort: a missing, foreign or unreadable folder never blocks a launch */ }
}

export function createSessionMcpConfig({
  serverName = 'rai',
  configDir = path.join(os.homedir(), '.raistudio'),
  bridgeDir = BRIDGE_DIR,
  token,
  healthUrl,
  inspectorUrl
} = {}) {
  token = token ?? requireBridgeToken();
  if (typeof token !== 'string' || token.length === 0) throw new BridgeConfigError('RAI_BRIDGE_TOKEN is required to create an MCP session config');

  const safeConfigDir = path.resolve(configDir);
  const scriptPath = path.resolve(bridgeDir, 'rai-native-mcp.js');
  const sessionHealthUrl = healthUrl ?? process.env.RAI_SESSION_HEALTH_URL;
  const sessionInspectorUrl = validateInspectorUrl(inspectorUrl ?? process.env.RAI_RUN_INSPECTOR_URL);
  if (typeof sessionHealthUrl !== 'string' || sessionHealthUrl.length === 0) {
    throw new BridgeConfigError('RAI_SESSION_HEALTH_URL is required to create an MCP session config');
  }
  mkdirSync(safeConfigDir, { recursive: true, mode: 0o700 });
  if (lstatSync(safeConfigDir).isSymbolicLink()) {
    throw new Error('MCP config directory must not be a symbolic link');
  }
  chmodSync(safeConfigDir, 0o700);
  removeStaleSessionConfigs(safeConfigDir);

  const configPath = path.join(safeConfigDir, `mcp-${process.pid}-${randomUUID()}.json`);
  const tempPath = `${configPath}.tmp`;
  const sessionDir = `${configPath}.session`;
  mkdirSync(sessionDir, { mode: 0o700 });
  const tokenPath = path.join(sessionDir, 'token');
  const contents = JSON.stringify({
    mcpServers: {
      [serverName]: {
        command: process.execPath,
        args: [scriptPath],
        env: {
          RAI_BRIDGE_TOKEN_FILE: tokenPath,
          RAI_MCP_SERVER_NAME: serverName,
          RAI_SESSION_HEALTH_URL: sessionHealthUrl,
          ...(sessionInspectorUrl ? { RAI_RUN_INSPECTOR_URL: sessionInspectorUrl } : {})
        }
      }
    }
  }, null, 2);
  let fd;
  try {
    fd = openSync(tokenPath, 'wx', 0o600);
    writeFileSync(fd, token);
    closeSync(fd);
    fd = undefined;
    fd = openSync(tempPath, 'wx', 0o600);
    writeFileSync(fd, contents);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, configPath);
    chmodSync(configPath, 0o600);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(sessionDir, { recursive: true, force: true });
    try { unlinkSync(configPath); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
    try { unlinkSync(tempPath); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
    throw error;
  }
  return { configPath, scriptPath };
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Codex's -c overrides can only set literal values on the command line, and
// Codex config.toml has no per-server env table we can point at without
// putting the token there in plaintext ourselves. So instead of handing
// Codex the token directly (command line, env, or config), we hand it an
// owner-only wrapper script that holds the token and execs Node; Codex's
// own process (and anything it inherits into) never sees RAI_BRIDGE_TOKEN.
export function createSessionCodexWrapper({
  configDir = path.join(os.homedir(), '.raistudio'),
  bridgeDir = BRIDGE_DIR,
  token,
  healthUrl,
  inspectorUrl
} = {}) {
  token = token ?? requireBridgeToken();
  if (typeof token !== 'string' || token.length === 0) throw new BridgeConfigError('RAI_BRIDGE_TOKEN is required to create a Codex MCP wrapper');

  const safeConfigDir = path.resolve(configDir);
  const scriptPath = path.resolve(bridgeDir, 'rai-native-mcp.js');
  const sessionHealthUrl = healthUrl ?? process.env.RAI_SESSION_HEALTH_URL;
  const sessionInspectorUrl = validateInspectorUrl(inspectorUrl ?? process.env.RAI_RUN_INSPECTOR_URL);
  if (typeof sessionHealthUrl !== 'string' || sessionHealthUrl.length === 0) {
    throw new BridgeConfigError('RAI_SESSION_HEALTH_URL is required to create an MCP session config');
  }
  mkdirSync(safeConfigDir, { recursive: true, mode: 0o700 });
  if (lstatSync(safeConfigDir).isSymbolicLink()) {
    throw new Error('MCP config directory must not be a symbolic link');
  }
  chmodSync(safeConfigDir, 0o700);
  removeStaleSessionConfigs(safeConfigDir);

  const wrapperPath = path.join(safeConfigDir, `mcp-${process.pid}-${randomUUID()}.sh`);
  const tempPath = `${wrapperPath}.tmp`;
  const contents = '#!/bin/sh\n' +
    `export RAI_BRIDGE_TOKEN=${shellQuote(token)}\n` +
    `export RAI_SESSION_HEALTH_URL=${shellQuote(sessionHealthUrl)}\n` +
    (sessionInspectorUrl ? `export RAI_RUN_INSPECTOR_URL=${shellQuote(sessionInspectorUrl)}\n` : '') +
    `exec ${shellQuote(process.execPath)} ${shellQuote(scriptPath)} "$@"\n`;
  let fd;
  try {
    fd = openSync(tempPath, 'wx', 0o700);
    writeFileSync(fd, contents);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, wrapperPath);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tempPath); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
    throw error;
  }
  chmodSync(wrapperPath, 0o700);
  return { configPath: wrapperPath, scriptPath };
}

// Grok reads <cwd>/.grok/config.toml, and grok 1.0.70 rejects --add-dir ("a
// session works only in its cwd"). So the session folder is the cwd and the
// project is reached through a ./project link inside it. Grok asks to trust any
// folder whose config it loads. --trust answers that for the session root only
// (a repository marker the bridge owns), never for the user's project. The
// wrapper holds the token.
function ensureGrokProjectRoot(configDir, projectDir) {
  const root = path.join(path.resolve(configDir), GROK_SESSIONS_DIR);
  const ownDirectory = dir => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Grok sessions directory must be a real directory');
    chmodSync(dir, 0o700);
  };
  ownDirectory(root);
  let real;
  try { real = realpathSync(projectDir); } catch { real = path.resolve(projectDir); }
  const projectRoot = path.join(root, createHash('sha256').update(real).digest('hex').slice(0, 16));
  ownDirectory(projectRoot);
  // Grok loads config from the repository root as trusted, so nothing but the
  // repository marker and the bridge's own session folders may live here.
  for (const name of GROK_PLANTED_CONFIG) rmSync(path.join(projectRoot, name), { recursive: true, force: true });
  const gitDir = path.join(projectRoot, '.git');
  if (existsSync(gitDir) && (lstatSync(gitDir).isSymbolicLink() || !lstatSync(gitDir).isDirectory())) rmSync(gitDir, { recursive: true, force: true });
  mkdirSync(path.join(gitDir, 'objects'), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(gitDir, 'refs'), { recursive: true, mode: 0o700 });
  if (!existsSync(path.join(gitDir, 'HEAD'))) {
    writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n', { mode: 0o600 });
  }
  return projectRoot;
}

// One fixed session folder per project keeps Grok's per-folder history, so
// --continue and --resume find earlier sessions. A second live bridge process on
// the same project gets its own throwaway folder instead of sharing this one.
function claimGrokSessionDir(projectRoot, wrapperName) {
  const stable = path.join(projectRoot, 'session');
  const ownerFile = path.join(projectRoot, 'session.owner');
  let owner = NaN;
  try { owner = Number(readFileSync(ownerFile, 'utf8')); } catch { /* unowned */ }
  if (Number.isInteger(owner) && owner !== process.pid && isProcessAlive(owner)) {
    return path.join(projectRoot, `${wrapperName}.session`);
  }
  rmSync(stable, { recursive: true, force: true });
  writeFileSync(ownerFile, String(process.pid), { mode: 0o600 });
  return stable;
}

function createIsolatedMcpWorkspace({
  provider,
  projectDir,
  configDir,
  bridgeDir,
  token,
  healthUrl,
  inspectorUrl,
  globalPrompt = ''
}) {
  void provider;
  const { configPath: wrapperPath } = createSessionCodexWrapper({
    configDir, bridgeDir, token, healthUrl, inspectorUrl
  });
  const serverName = `rai_studio_session_${randomUUID().replaceAll('-', '')}`;
  let sessionDir;
  try {
    sessionDir = claimGrokSessionDir(ensureGrokProjectRoot(configDir, projectDir), path.basename(wrapperPath));
    mkdirSync(sessionDir, { mode: 0o700 });
    chmodSync(sessionDir, 0o700);
    const grokDir = path.join(sessionDir, '.grok');
    mkdirSync(grokDir, { mode: 0o700 });
    chmodSync(grokDir, 0o700);
    const toml = `[mcp_servers.${serverName}]\ncommand = ${tomlString(wrapperPath)}\nargs = []\nenabled = true\n` +
      `[mcp_servers.${serverName}.env]\nRAI_MCP_SERVER_NAME = ${tomlString(serverName)}\n`;
    const fd = openSync(path.join(grokDir, 'config.toml'), 'wx', 0o600);
    try { writeFileSync(fd, toml); } finally { closeSync(fd); }
    symlinkSync(path.resolve(projectDir), path.join(sessionDir, 'project'), 'dir');
    const notes = 'This folder is an RAI-Studio assistant session. The user\'s project is the ./project link in this folder. ' +
      'Read, search and edit project files through ./project/, and also read ./project/AGENTS.md if it exists.\n\n' +
      composeAssistantInstructions(renderSessionInstructions(readFileSync(RAI_ASSISTANT_SKILL, 'utf8'), serverName), globalPrompt);
    writeFileSync(path.join(sessionDir, 'AGENTS.md'), notes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    removeSessionMcpConfig(wrapperPath, { configDir });
    throw error;
  }
  return { configPath: wrapperPath, launchArgs: ['--trust', '--cwd', sessionDir] };
}

// OpenCode has no CLI flag or per-invocation MCP config path like Claude's
// --mcp-config: it only discovers MCP servers from its own JSON config file
// (opencode.jsonc "mcp" object), found via project-local opencode.json, its
// global ~/.config/opencode/opencode.json, or the OPENCODE_CONFIG env var
// pointing at a custom path (https://opencode.ai/docs/config/#custom-path).
// Native file substitution keeps the bearer out of the provider's env/argv
// while an inline rai MCP overlay preserves existing native configuration.
export function createSessionOpenCodeConfig({
  configDir = path.join(os.homedir(), '.raistudio'),
  bridgeDir = BRIDGE_DIR,
  token,
  healthUrl,
  inspectorUrl,
  globalPrompt = ''
} = {}) {
  token = token ?? requireBridgeToken();
  if (typeof token !== 'string' || token.length === 0) throw new BridgeConfigError('RAI_BRIDGE_TOKEN is required to create an OpenCode MCP session config');

  const safeConfigDir = path.resolve(configDir);
  const scriptPath = path.resolve(bridgeDir, 'rai-native-mcp.js');
  const sessionHealthUrl = healthUrl ?? process.env.RAI_SESSION_HEALTH_URL;
  const sessionInspectorUrl = validateInspectorUrl(inspectorUrl ?? process.env.RAI_RUN_INSPECTOR_URL);
  if (typeof sessionHealthUrl !== 'string' || sessionHealthUrl.length === 0) {
    throw new BridgeConfigError('RAI_SESSION_HEALTH_URL is required to create an MCP session config');
  }
  mkdirSync(safeConfigDir, { recursive: true, mode: 0o700 });
  if (lstatSync(safeConfigDir).isSymbolicLink()) {
    throw new Error('MCP config directory must not be a symbolic link');
  }
  chmodSync(safeConfigDir, 0o700);
  removeStaleSessionConfigs(safeConfigDir);

  const configPath = path.join(safeConfigDir, `mcp-${process.pid}-${randomUUID()}.json`);
  const tempPath = `${configPath}.tmp`;
  const tokenPath = `${configPath}.token`;
  if (/[{}\r\n]/.test(tokenPath))
    throw new BridgeConfigError('OpenCode token path cannot be represented as a native file reference');
  const instructionFile = writeSessionInstructions(configPath, globalPrompt, 'rai');
  const config = {
    $schema: 'https://opencode.ai/config.json',
    // OpenCode loads an owner-only per-session instructions file. Never
    // modify global/project config or pass preference text through argv.
    instructions: [instructionFile],
    // Do not inject permission rules: native/user/managed policies own approvals.
    mcp: {
      rai: {
        type: 'local',
        command: [process.execPath, scriptPath],
        enabled: true,
        environment: {
          RAI_BRIDGE_TOKEN: `{file:${tokenPath}}`,
          RAI_MCP_SERVER_NAME: 'rai',
          RAI_SESSION_HEALTH_URL: sessionHealthUrl,
          ...(sessionInspectorUrl ? { RAI_RUN_INSPECTOR_URL: sessionInspectorUrl } : {})
        }
      }
    }
  };
  let fd;
  let tokenOwned = false;
  let tempOwned = false;
  let configOwned = false;
  try {
    fd = openSync(tokenPath, 'wx', 0o600);
    tokenOwned = true;
    writeFileSync(fd, token);
    closeSync(fd);
    fd = undefined;
    fd = openSync(tempPath, 'wx', 0o600);
    tempOwned = true;
    writeFileSync(fd, JSON.stringify(config, null, 2));
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, configPath);
    configOwned = true;
    chmodSync(configPath, 0o600);
  } catch (error) {
    const cleanupErrors = [];
    if (fd !== undefined) { try { closeSync(fd); } catch (cleanupError) { cleanupErrors.push(cleanupError); } }
    for (const artifact of [tempOwned && tempPath, configOwned && configPath, tokenOwned && tokenPath,
      sessionInstructionsPath(configPath)].filter(Boolean)) {
      try { unlinkSync(artifact); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], 'OpenCode session configuration cleanup failed');
    throw error;
  }
  return { configPath, scriptPath, config };
}

function removeGrokSessionFolder(configDir, wrapperPath) {
  const root = path.join(configDir, GROK_SESSIONS_DIR);
  const name = `${path.basename(wrapperPath)}.session`;
  let projects;
  try { if (!lstatSync(root).isDirectory()) return; projects = readdirSync(root, { withFileTypes: true }); }
  catch { return; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectRoot = path.join(root, project.name);
    rmSync(path.join(projectRoot, name), { recursive: true, force: true });
    // The fixed folder is removed only by the launch that wrote its MCP entry.
    const stable = path.join(projectRoot, 'session');
    let written = '';
    try { written = readFileSync(path.join(stable, '.grok', 'config.toml'), 'utf8'); } catch { continue; }
    if (written.includes(tomlString(wrapperPath))) {
      rmSync(stable, { recursive: true, force: true });
      rmSync(path.join(projectRoot, 'session.owner'), { force: true });
    }
  }
}

export function removeSessionMcpConfig(configPath, { configDir = path.join(os.homedir(), '.raistudio') } = {}) {
  const safeConfigDir = path.resolve(configDir);
  const safeConfigPath = path.resolve(configPath);
  const match = path.basename(safeConfigPath).match(SESSION_CONFIG);
  if (path.dirname(safeConfigPath) !== safeConfigDir || !match || Number(match[1]) !== process.pid) return false;
  let removed = false;
  for (const artifact of [safeConfigPath, sessionInstructionsPath(safeConfigPath), `${safeConfigPath}.token`]) {
    try { unlinkSync(artifact); removed = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  rmSync(`${safeConfigPath}.session`, { recursive: true, force: true });
  removeGrokSessionFolder(safeConfigDir, safeConfigPath);
  return removed;
}

// Installed Claude 2.1.310 (Commander) and Codex --help declarations, checked
// by launch-argv.test.js when installed. Hidden value options are checked
// against Claude root declarations and Codex parser completions. Unknown options
// are boolean: never guess that the next token is their value. New native value
// options need this table.
export const CLI_OPTION_ARITY = {
  claude: {
    required: [
      '--fast-mode', '--runner-declares', '--thinking', '--thinking-display', '--max-thinking-tokens', '--max-turns', '--task-budget',
      '--permission-prompt-tool', '--append-subagent-system-prompt', '--append-subagent-system-prompt-file',
      '--plan-mode-instructions', '--inherit-permission-mode', '--watch-artifact',
      '--watch-artifact-no-autoreact', '--prefill', '--deep-link-repo', '--deep-link-last-fetch',
      '--prefill-b64', '--deep-link-cwd-b64', '--resume-session-at', '--resume-drops-turn',
      '--rewind-files', '--workload', '--client-data-url',
      '--managed-settings', '--project-config-root', '--advisor', '--proactivity', '--messaging-socket-path',
      '--agent-id', '--agent-name', '--team-name', '--agent-color', '--parent-session-id', '--teammate-mode',
      '--agent-type', '--sdk-url', '--forward-home-settings', '--attach-serve', '--pool', '--correlation-id',
      '--ref', '--on-branch', '--agent', '--agents', '--append-system-prompt', '--autocompact', '--debug-file',
      '--effort',
      '--environment', '--fallback-model', '--input-format', '--json-schema', '--max-budget-usd', '--model',
      '-n', '--name', '--output-format', '--permission-mode', '--permission-prompts', '--plugin-dir',
      '--plugin-url', '--remote-control-session-name-prefix', '--session-id', '--setting-sources',
      '--settings', '--system-prompt', '--system-prompt-snapshot', '--system-prompt-file',
      '--append-system-prompt-file', '--plugin-dir-no-mcp'],
    optional: [
      '--remote',
      '--rc', '--cloud', '-d', '--debug', '--from-pr', '--prompt-suggestions', '--remote-control', '-r',
      '--resume', '--teleport', '-w', '--worktree'],
    variadic: [
      '--channels', '--dangerously-load-development-channels', '--add-dir', '--allowedTools', '--allowed-tools',
      '--betas', '--disallowedTools',
      '--disallowed-tools', '--file', '--mcp-config', '--tools'],
    boolean: ['--allow-dangerously-skip-permissions', '--ax-screen-reader', '--bg', '--background', '--bare',
      '--brief', '--chrome', '-c', '--continue', '--dangerously-skip-permissions', '--desktop',
      '--disable-slash-commands', '--exclude-dynamic-system-prompt-sections', '--fork-session',
      '--forward-subagent-text', '-h', '--help', '--ide', '--include-hook-events',
      '--include-partial-messages', '--no-chrome', '--no-session-persistence', '-p', '--print',
      '--replay-user-messages', '--restricted', '--safe-mode', '--strict-mcp-config', '--tmux', '--verbose',
      '-v', '--version']
  },
  codex: {
    required: ['-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '-m',
      '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a',
      '--ask-for-approval'],
    optional: [],
    variadic: ['-i', '--image'],
    boolean: ['--strict-config', '--oss', '--approve-for-me', '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-hook-trust', '--worktree', '--search', '--no-alt-screen', '--no-daemon', '-h',
      '--help', '-V', '--version']
  }
};

function nativeArgv(provider, argv) {
  const arities = CLI_OPTION_ARITY[provider];
  const flags = [];
  let boundary = argv.length;
  if (!arities) {
    const terminator = argv.indexOf('--');
    return { flags, boundary: terminator === -1 ? boundary : terminator };
  }
  const arityOf = flag => Object.keys(arities).find(arity => arities[arity].includes(flag));
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { boundary = i; break; }
    if (!arg.startsWith('-') || arg === '-') continue;
    // Both parsers accept attached short values; boolean short options may
    // cluster. Long options match exactly, without prefix abbreviations.
    const options = arg.startsWith('--') ? [arg] : arg.slice(1).split('').map(letter => `-${letter}`);
    for (let j = 0; j < options.length; j++) {
      const flag = options[j].split('=')[0];
      const arity = arityOf(flag);
      if (!arity) break; // Unknown options never consume a following token
      let value;
      let attached = false;
      if (arg.startsWith('--')) {
        attached = arg.includes('=');
        if (attached) value = arg.slice(arg.indexOf('=') + 1);
      } else if (arity !== 'boolean' && j + 1 < options.length) {
        attached = true;
        value = arg.slice(j + 2);
        // Codex accepts -c=key=value as well as -ckey=value.
        if (provider === 'codex' && value.startsWith('=')) value = value.slice(1);
      }
      if (arity !== 'boolean') {
        const next = argv[i + 1];
        // Commander required values (including the first variadic value) are
        // literal. Optional values stop at options. Clap rejects dash-prefixed
        // separate values, including --, rather than consuming them.
        if (!attached && next !== undefined &&
            ((provider === 'claude' && arity !== 'optional') || !next.startsWith('-') || next === '-')) value = argv[++i];
        if (arity === 'variadic' && value !== undefined) {
          while (i + 1 < argv.length && (!argv[i + 1].startsWith('-') || argv[i + 1] === '-')) i++;
        }
      }
      flags.push({ flag, value });
      if (arity !== 'boolean') break;
    }
  }
  return { flags, boundary };
}

function codexKeyConflict(override) {
  const key = override.split('=')[0].trim();
  return key === 'developer_instructions' || key === 'mcp_servers'
    || key === 'mcp_servers.rai' || key.startsWith('mcp_servers.rai.');
}

// Pure: resolves the provider command, args (including the MCP config/wrapper
// this session will authenticate with), and a scrubbed env -- with no pty or
// child_process dependency, so both the embedded node-pty terminal and a
// standalone launcher (e.g. a real Terminal.app window) can share it.
export function buildCliLaunch({ provider, profile, model, effort, globalPrompt = '', autoApprove, configDir, bridgeDir = BRIDGE_DIR, cwd, env = process.env }) {
  validateGlobalPrompt(globalPrompt);
  // Retired compatibility input: validate its type, never use it as policy.
  if (autoApprove !== undefined && typeof autoApprove !== 'boolean') throw new BridgeConfigError('autoApprove must be boolean');
  let openCodeInline = {};
  let notice;
  if (provider === 'opencode' && env.OPENCODE_CONFIG_CONTENT) {
    try {
      openCodeInline = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
      if (!openCodeInline || typeof openCodeInline !== 'object' || Array.isArray(openCodeInline)
          || (openCodeInline.mcp !== undefined && (!openCodeInline.mcp || typeof openCodeInline.mcp !== 'object' || Array.isArray(openCodeInline.mcp)))
          || (openCodeInline.instructions !== undefined && (!Array.isArray(openCodeInline.instructions) || openCodeInline.instructions.some(value => typeof value !== 'string'))))
        throw new Error('unsafe inline merge');
    } catch {
      openCodeInline = null;
      notice = 'RAI MCP wiring skipped: OpenCode inline configuration cannot be safely merged; native content preserved';
      console.warn(notice);
    }
  }
  const token = requireBridgeToken(env);
  const configured = profile.args ?? [];
  if (!Array.isArray(configured) || configured.some(arg => typeof arg !== 'string'))
    throw new BridgeConfigError('provider CLI arguments must be an array of strings');
  // Refuse connector replacements before creating any session files
  const claudeReserved = new Set(['--append-system-prompt-file', '--mcp-config']);
  const { flags, boundary } = nativeArgv(provider, configured);
  for (const { flag, value } of flags) {
    const conflict = (provider === 'claude' && claudeReserved.has(flag))
      || (provider === 'codex' && (flag === '-c' || flag === '--config') && value !== undefined && codexKeyConflict(value));
    if (conflict) throw new BridgeConfigError('RAI connector conflict: native CLI arguments replace session wiring; remove the conflicting option to launch');
  }
  if (provider === 'grok' && configured.slice(0, boundary).some(arg => /^(--cwd|--add-dir|--trust|-w|--worktree)(=|$)/.test(arg))) {
    throw new BridgeConfigError('RAI connector conflict: grok --cwd, --add-dir, --trust and --worktree are set by the session launch; remove the option to launch');
  }
  const args = configured.slice(0, boundary);
  // Keep a missing native variadic value missing: appended RAI options must
  // not become its argument. The native parser still owns the error.
  const nativeTail = provider === 'claude' && flags.some(({ flag, value }) =>
    (flag === '--allowedTools' || flag === '--allowed-tools') && value === undefined)
    ? args.splice(-1) : [];
  // Retired UI settings stay ignored; native argv remains authoritative
  void model;
  void effort;
  let configPath;
  let openCodeSession;
  let launchArgs;
  const codexServerName = provider === 'codex' ? `rai_studio_session_${randomUUID().replaceAll('-', '')}` : undefined;
  if (provider === 'claude') {
    // A fresh namespace keeps native rai servers outside RAI approvals.
    const serverName = `rai_studio_session_${randomUUID().replaceAll('-', '')}`;
    ({ configPath } = createSessionMcpConfig({
      configDir, bridgeDir, token, serverName,
      healthUrl: env.RAI_SESSION_HEALTH_URL,
      inspectorUrl: env.RAI_RUN_INSPECTOR_URL
    }));
    // Session-scoped companion instructions plus the optional RAI-only
    // user global prompt; provider-wide settings remain untouched.
    let instructionsPath;
    try { instructionsPath = writeSessionInstructions(configPath, globalPrompt, serverName); }
    catch (error) { removeSessionMcpConfig(configPath, { configDir }); throw error; }
    args.push('--append-system-prompt-file', instructionsPath);
    // The plugin directory is an official Claude CLI session-only extension
    // point. It supplies /rai-audit without global or project-local injection.
    if (!userAuditSkillExists(env)) {
      const pluginDir = path.join(`${configPath}.session`, 'plugin');
      try {
        cpSync(RAI_AUDIT_PLUGIN_DIR, pluginDir, { recursive: true });
        const skillPath = path.join(pluginDir, 'SKILL.md');
        writeFileSync(skillPath, renderSessionInstructions(readFileSync(skillPath, 'utf8'), serverName));
      } catch (error) { removeSessionMcpConfig(configPath, { configDir }); throw error; }
      args.push('--plugin-dir', pluginDir);
    }
    // Auto-approval is scoped to this server's guarded MCP tools only.
    // Native tools, subagents and permission mode remain the user's own policy.
    args.push('--allowedTools', ...cliAllowedToolNames().map(name => name.replace('mcp__rai__', `mcp__${serverName}__`)));
  } else if (provider === 'codex') {
    // Codex otherwise discovers host Computer Use tools and may try to drive
    // RStudio's UI rather than use this session's strict native run_r path.
    // Developer guidance is scoped to this embedded invocation; it changes
    // neither global config nor any approval/sandbox policy.
    args.push('-c', `developer_instructions=${tomlString(composeAssistantInstructions(renderSessionInstructions(readFileSync(RAI_ASSISTANT_SKILL, 'utf8'), codexServerName), globalPrompt))}`);
    // The user's native sandbox/approval policy is independent of RAI MCP auto-approval.
    ({ configPath } = createSessionCodexWrapper({
      configDir, bridgeDir, token,
      healthUrl: env.RAI_SESSION_HEALTH_URL,
      inspectorUrl: env.RAI_RUN_INSPECTOR_URL
    }));
  } else if (provider === 'opencode' && openCodeInline !== null) {
    ({ configPath, config: openCodeSession } = createSessionOpenCodeConfig({
      configDir, bridgeDir, token, globalPrompt,
      healthUrl: env.RAI_SESSION_HEALTH_URL,
      inspectorUrl: env.RAI_RUN_INSPECTOR_URL
    }));
  } else if (provider === 'grok' && typeof cwd === 'string' && cwd.length > 0) {
    ({ configPath, launchArgs } = createIsolatedMcpWorkspace({
      provider, projectDir: cwd, configDir, bridgeDir, token, globalPrompt,
      healthUrl: env.RAI_SESSION_HEALTH_URL,
      inspectorUrl: env.RAI_RUN_INSPECTOR_URL
    }));
    args.push(...launchArgs);
  }
  args.push(...buildMcpArgs(provider, configPath, undefined, codexServerName));
  args.push(...nativeTail, ...configured.slice(boundary));

  // The provider TUI itself never needs (and must never inherit) the bridge
  // token: Claude gets a private token-file reference, Codex via the
  // owner-only wrapper script above, OpenCode via a private file reference
  // in its additive inline config -- all scoped to just
  // the rai MCP subprocess, not the outer provider process the model can
  // inspect.
  // RAI_OWNER_TOKEN is the same secret under a second name (the C++ side
  // sets both from one token) -- scrub it too, or a provider process that
  // inherited the bridge's own env (e.g. RAI_OWNER_TOKEN set process-wide
  // before this snapshot was taken) hands the model a way to call the
  // session's /run endpoint directly, bypassing the MCP approval gate.
  const childEnv = { ...env, TERM: 'xterm-256color' };
  if (provider === 'opencode' && openCodeInline !== null) {
    // A session namespace avoids shadowing servers discovered from native files
    let serverName = `rai_studio_session_${path.basename(configPath, '.json').replaceAll('-', '_').slice(4)}`;
    while (Object.hasOwn(openCodeInline.mcp || {}, serverName)) serverName += '_1';
    openCodeSession.mcp.rai.environment.RAI_MCP_SERVER_NAME = serverName;
    writeFileSync(sessionInstructionsPath(configPath), composeAssistantInstructions(renderSessionInstructions(readFileSync(RAI_ASSISTANT_SKILL, 'utf8'), serverName), globalPrompt));
    childEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...openCodeInline,
      instructions: [...(openCodeInline.instructions || []), ...openCodeSession.instructions],
      mcp: { ...openCodeInline.mcp, [serverName]: openCodeSession.mcp.rai }
    });
  }
  delete childEnv.RAI_BRIDGE_TOKEN;
  delete childEnv.RAI_OWNER_TOKEN;
  delete childEnv.RAI_RUN_INSPECTOR_URL;
  // OpenCode retains OPENCODE_CONFIG and its native JSONC/config discovery.
  // Inline wiring references an owner-only token file, not a bearer in env.

  const command = resolveBinary(profile.command);

  return { command, args, configPath, env: childEnv, ...(notice ? { notice } : {}) };
}

export function createCliSession({ provider, profile, model, effort, globalPrompt = '', autoApprove, configDir, bridgeDir, cwd, cols = 120, rows = 40, env = process.env, spawn }) {
  const { command, args, configPath, env: childEnv, notice } = buildCliLaunch({
    provider, profile, model, effort, globalPrompt, autoApprove, configDir, bridgeDir, cwd, env
  });
  try {
    const term = spawn(command, args, {
      name: 'xterm-256color', cols: Math.max(1, cols | 0), rows: Math.max(1, rows | 0), cwd,
      env: childEnv, encoding: null
    });
    return { term, configPath, ...(notice ? { notice } : {}) };
  } catch (error) {
    if (configPath) removeSessionMcpConfig(configPath, { configDir });
    throw error;
  }
}

export function mergeSettings(config, settings) {
  const next = { ...config, model: '', effort: '', providers: structuredClone(config.providers || {}) };
  if (settings && typeof settings === 'object') {
    // Never use a request-controlled key to index a normal object without an
    // own-property check: values such as "__proto__" otherwise reach the
    // prototype chain and can mutate Object.prototype (CWE-1321).
    const requestedProvider = Object.hasOwn(settings, 'provider') ? settings.provider : next.provider;
    if (typeof requestedProvider === 'string' && Object.hasOwn(next.providers, requestedProvider)) {
      next.provider = requestedProvider;
      // Model and effort overrides are intentionally ignored.
      // Subscription OAuth is the only supported account mode.
      next.providers[next.provider].authMode = 'subscription';
    }
  }
  return next;
}

export function validateProfile(profile) {
  if (!profile || typeof profile !== 'object') return { ok: false, error: 'profile must be an object' };
  if (!profile.providers || typeof profile.providers !== 'object') return { ok: false, error: 'providers must be an object' };
  if (typeof profile.provider !== 'string' || !profile.providers[profile.provider]) {
    return { ok: false, error: `unknown provider: ${profile.provider}` };
  }

  const provider = profile.providers[profile.provider];
  if (!provider || typeof provider !== 'object') return { ok: false, error: 'provider profile must be an object' };
  if (typeof provider.command !== 'string' || provider.command.trim() === '') {
    return { ok: false, error: 'provider command must be a non-empty string' };
  }
  if (!Array.isArray(provider.args) || !provider.args.every(arg => typeof arg === 'string')) {
    return { ok: false, error: 'provider args must be an array of strings' };
  }
  if (provider.modelFlag !== undefined && typeof provider.modelFlag !== 'string') {
    return { ok: false, error: 'provider modelFlag must be a string' };
  }
  if (provider.authMode !== undefined && !['subscription', 'api'].includes(provider.authMode)) {
    return { ok: false, error: 'provider authMode must be subscription or api' };
  }
  if (profile.model !== undefined && typeof profile.model !== 'string') {
    return { ok: false, error: 'model must be a string' };
  }
  if (profile.effort !== undefined && typeof profile.effort !== 'string') {
    return { ok: false, error: 'effort must be a string' };
  }
  if (provider.efforts !== undefined && (!Array.isArray(provider.efforts) ||
      !provider.efforts.every(effort => typeof effort === 'string'))) {
    return { ok: false, error: 'provider efforts must be an array of strings' };
  }
  if (profile.effort && (!Array.isArray(provider.efforts) || !provider.efforts.includes(profile.effort))) {
    return { ok: false, error: `unsupported effort for ${profile.provider}: ${profile.effort}` };
  }
  return { ok: true };
}
