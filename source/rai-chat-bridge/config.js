// Provider/model settings shared by the embedded bridge server and any
// standalone launcher (e.g. generate-launch.js) -- both read/write the same
// ~/.raistudio/assistant.json so switching providers in one place is
// consistent everywhere.
import { readFileSync, writeFileSync, mkdirSync, renameSync, openSync, closeSync, chmodSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { SCOPED_GUIDANCE, DEFAULT_SNIPPETS, normalizeSnippets, validateSnippets } from './public/scoped-guidance.js';
import { validateGlobalPrompt } from './public/global-prompt.js';

export const CONFIG_DIR = path.join(os.homedir(), '.raistudio');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'assistant.json');

export const DEFAULT_CONFIG = {
  settingsVersion: 2,
  globalPrompt: '',
  provider: 'claude',
  model: 'opus',
  // Empty means Auto: preserve the provider CLI's own default effort.
  effort: '',
  // Keep the terminal's CLI process (and the machine) awake for the
  // duration of the session via `caffeinate -d -t` on macOS. Defaults on;
  // toggled from the RAI Assistant toolbar checkbox.
  caffeinate: true,
  saveOnEdit: true,
  // Retired compatibility value. Preserve stored booleans for exact settings
  // acknowledgements; the bridge always preapproves only its guarded RAI MCP
  // tools, independently of this field. Native session validation still owns
  // whether an individual proposal is eligible to execute.
  autoApproveReadOnly: true,
  snippets: structuredClone(DEFAULT_SNIPPETS),
  providers: {
    claude: {
      command: 'claude', args: [], modelFlag: '--model', authMode: 'subscription',
      models: ['opus', 'sonnet', 'haiku'],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max']
    },
    codex: {
      command: 'codex', args: [], modelFlag: '--model', authMode: 'subscription',
      models: ['gpt-5.1-codex', 'gpt-5.1-codex-mini', 'o3'],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    },
    // OpenCode is a multi-vendor CLI (models are "provider/model" strings,
    // e.g. anthropic/claude-sonnet-4-5) with no fixed model roster and no
    // documented reasoning-effort selector, so both lists start empty --
    // matching this codebase's existing policy of never forwarding
    // model/effort to CLI launches; account defaults are used as-is.
    opencode: {
      command: 'opencode', args: [], modelFlag: '--model', authMode: 'subscription',
      models: [],
      efforts: []
    },
    // Grok Build CLI. No fixed model roster is forwarded; the CLI keeps its
    // account default. Session MCP stays out of ~/.grok.
    grok: {
      command: 'grok', args: [], modelFlag: '--model', authMode: 'subscription',
      models: [],
      efforts: []
    }
  }
};

// Exact v0.1.59 shipped prompt identities: upgrade only text still equal to
// those defaults. Renamed snippets and hand-edited prompts remain the user's.
const LEGACY_SNIPPET_PROMPT_SHA256 = Object.freeze({
  writing: 'a5460614eac4605d97f8671febc676e1ff0c2dbce2dc7d5a3e906364959ac23b',
  analysis: 'f20127d3b8970da60092c17e645385fcf28c4cb91428fd5ea2e2d2c98d1126a9'
});

export function migrateShippedSnippetDefaults(snippets) {
  const result = validateSnippets(snippets, { stored: true });
  const untouched = ['writing', 'analysis'].filter(id => result[id] &&
    snippets[id].name === DEFAULT_SNIPPETS[id].name &&
    (result[id].prompt === SCOPED_GUIDANCE[id] ||
      createHash('sha256').update(result[id].prompt).digest('hex') === LEGACY_SNIPPET_PROMPT_SHA256[id]));
  if (Object.keys(result).join(',') === 'writing,analysis' && untouched.length === 2)
    return structuredClone(DEFAULT_SNIPPETS);
  for (const id of untouched) result[id] = { ...result[id], prompt: DEFAULT_SNIPPETS[id].prompt };
  return result;
}

export function writeConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${CONFIG_FILE}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    const { settingsRecovery, ...persisted } = cfg;
    const bytes = Buffer.from(JSON.stringify(persisted, null, 2));
    writeFileSync(fd, bytes);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, CONFIG_FILE);
    chmodSync(CONFIG_FILE, 0o600);
    return bytes;
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* Preserve original error. */ }
  }
}

// Backfill fields added to DEFAULT_CONFIG.providers (e.g. `models`) into a
// config file written by an older version of this bridge, without touching
// anything the user already customized (command/args/modelFlag, or a
// provider they added themselves).
export function backfillProviderDefaults(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) ||
      !cfg.providers || typeof cfg.providers !== 'object' || Array.isArray(cfg.providers))
    throw new TypeError('invalid assistant settings; providers missing');
  if (cfg.settingsVersion !== undefined && cfg.settingsVersion !== 1 && cfg.settingsVersion !== 2)
    throw new TypeError('unsupported assistant settings version');
  // Retired legacy field: RAI saving is always on, so any stored value reads as true.
  cfg.saveOnEdit = true;
  cfg.settingsVersion = 2;
  cfg.globalPrompt = validateGlobalPrompt(cfg.globalPrompt ?? '');
  if (cfg.snippets !== undefined) cfg.snippets = migrateShippedSnippetDefaults(cfg.snippets);
  // The Cursor Agent CLI is a different program. Drop only the untouched
  // provider entry this release briefly added, and keep a hand-edited one.
  const shippedCursor = cfg.providers.cursor;
  if (shippedCursor && shippedCursor.command === 'agent' &&
      Array.isArray(shippedCursor.args) && shippedCursor.args.length === 0 &&
      (!shippedCursor.models || shippedCursor.models.length === 0))
    delete cfg.providers.cursor;
  if (cfg.provider === 'cursor') cfg.provider = 'grok';
  for (const [key, defaults] of Object.entries(DEFAULT_CONFIG.providers)) {
    const p = cfg.providers[key];
    if (!p) cfg.providers[key] = structuredClone(defaults);
    else {
      if (!p.models) p.models = defaults.models;
      if (!p.efforts) p.efforts = defaults.efforts;
      // RAI-Studio is subscription-only. Never retain API mode in config.
      p.authMode = 'subscription';
    }
  }
  // Account defaults only: discard stale per-provider launch overrides.
  cfg.model = '';
  cfg.effort = '';
  // Preserve stored caffeinate choices and the retired approval boolean.
  // The latter is inert policy compatibility, not a manual-approval opt-out;
  // do not rewrite it during a raw snapshot or alter committed-byte acks.
  if (typeof cfg.caffeinate !== 'boolean') cfg.caffeinate = DEFAULT_CONFIG.caffeinate;
  if (typeof cfg.autoApproveReadOnly !== 'boolean')
    cfg.autoApproveReadOnly = DEFAULT_CONFIG.autoApproveReadOnly;
  cfg.snippets = normalizeSnippets(cfg.snippets);
  return cfg;
}

export function loadConfig(options) {
  return readConfigSnapshot(options).settings;
}

// Pair derived settings with the exact captured/committed bytes, never a second read.
export function readConfigSnapshot({ persistMigration = true } = {}) {
  const raw = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE) : null;
  if (raw === null) {
    const cfg = structuredClone(DEFAULT_CONFIG);
    return { settings: cfg, bytes: persistMigration ? writeConfig(cfg) : Buffer.alloc(0) };
  }
  let cfg;
  let stored;
  try {
    stored = JSON.parse(raw.toString('utf8'));
    cfg = backfillProviderDefaults(structuredClone(stored));
  } catch (error) {
    if (!persistMigration) {
      const temporary = structuredClone(DEFAULT_CONFIG);
      temporary.settingsRecovery = 'Native settings could not be read; original bytes preserved. No bridge recovery or fallback write.';
      return { settings: temporary, bytes: raw };
    }
    // Parse/schema failure: preserve exact live bytes and an owner-only backup.
    // No fallback write until an explicit Settings Save by the user.
    const backup = `${CONFIG_FILE}.recovery-${createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
    if (!existsSync(backup)) {
      let fd;
      try {
        fd = openSync(backup, 'wx', 0o600);
        writeFileSync(fd, raw);
      } finally { if (fd !== undefined) closeSync(fd); }
    } else if (!readFileSync(backup).equals(raw)) {
      throw new Error('settings recovery backup collision; original settings were not changed');
    }
    chmodSync(backup, 0o600);
    const temporary = structuredClone(DEFAULT_CONFIG);
    temporary.settingsRecovery = `Settings could not be read (${error.message}). Original remains at ${CONFIG_FILE}; backup saved as ${backup}. Defaults are temporary; Save in Settings explicitly replaces the invalid file.`;
    return { settings: temporary, bytes: raw };
  }
  // Migration write failure is NOT corruption. Fail without replacing a valid
  // config with defaults; the atomic writer leaves its original bytes intact.
  const changed = JSON.stringify(cfg) !== JSON.stringify(stored);
  return { settings: cfg, bytes: persistMigration && changed ? writeConfig(cfg) : raw };
}
