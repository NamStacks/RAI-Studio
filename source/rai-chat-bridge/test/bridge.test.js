import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BridgeConfigError, buildCliLaunch, buildMcpArgs, commandExists, createCliSession, createSessionCodexWrapper, createSessionMcpConfig, createSessionOpenCodeConfig, mergeSettings, removeSessionMcpConfig, shellQuote, validateProfile } from '../mcp.js';
import { catalogForSettings } from '../model-catalog.js';
import { createCaffeinateGuard } from '../caffeinate-guard.js';
import { DEFAULT_CONFIG, backfillProviderDefaults } from '../config.js';
import { APPROVAL_GATED_TOOL_NAMES, cliAllowedToolNames, tools as nativeTools } from '../rai-native-mcp.js';

const TEST_HEALTH_URL = 'http://127.0.0.1:19090/rsession-local/rai-assistant/health';

test('rejects unknown provider', () => {
  assert.equal(validateProfile({ provider: 'nope', providers: {} }).ok, false);
});

test('rejects non-array args', () => {
  const profile = {
    provider: 'claude',
    providers: { claude: { command: 'claude', args: 'x' } }
  };
  assert.equal(validateProfile(profile).ok, false);
});

test('accepts a well-formed claude profile', () => {
  const profile = {
    provider: 'claude',
    model: 'opus',
    providers: { claude: { command: 'claude', args: [], modelFlag: '--model' } }
  };
  assert.equal(validateProfile(profile).ok, true);
});

test('finds the node command', () => {
  assert.equal(commandExists('node'), true);
});

test('accepts an absolute executable path', () => {
  assert.equal(commandExists(process.execPath), true);
});

// resolveBinary/commandExists/findBinary are shared across every provider --
// not opencode-specific -- so a fallback path added for opencode's install
// methods also fixes the identical problem for claude/codex installed the
// same way (npm under nvm, pnpm, yarn, Volta, or ~/.local/bin). These tests
// exercise that shared resolver directly against a real filesystem (not
// process.env.PATH, which the resolver deliberately falls back past).
// Synthetic binary names are used instead of literal 'claude'/'codex' so the
// test is not flaky on a dev machine that already has those installed at a
// fixed prefix (e.g. /opt/homebrew/bin) -- that prefix is checked before the
// per-package-manager fallbacks below and would otherwise shadow the fake
// candidate under test, even though the underlying code path (and therefore
// the real-world fix for claude/codex) is identical.
{
  const { resolveBinary } = await import('../mcp.js');

  for (const [label, relDir] of [
    ['nvm-installed npm global', path.join('.nvm', 'versions', 'node', 'v20.11.0', 'bin')],
    ['Volta shim', path.join('.volta', 'bin')],
    ['pnpm global bin (macOS)', path.join('Library', 'pnpm')],
    ['pnpm global bin (Linux/XDG)', path.join('.local', 'share', 'pnpm')],
    ['yarn classic global bin', path.join('.yarn', 'bin')],
    ['native installer launcher (~/.local/bin)', path.join('.local', 'bin')]
  ]) {
    for (const providerName of ['claude-cli-test', 'codex-cli-test']) {
      test(`resolveBinary finds a ${providerName} binary installed via ${label}`, () => {
        const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'rai-fakehome-'));
        const binDir = path.join(fakeHome, relDir);
        mkdirSync(binDir, { recursive: true });
        const binPath = path.join(binDir, providerName);
        writeFileSync(binPath, '#!/bin/sh\necho fake\n', { mode: 0o755 });

        const originalHome = process.env.HOME;
        const originalPath = process.env.PATH;
        try {
          process.env.HOME = fakeHome;
          process.env.PATH = '/usr/bin:/bin'; // deliberately excludes binDir
          assert.equal(resolveBinary(providerName), binPath);
        } finally {
          process.env.HOME = originalHome;
          process.env.PATH = originalPath;
        }
      });
    }
  }
}


test('settings enforce subscription-only provider defaults', () => {
  const config = {
    provider: 'claude', model: 'opus', effort: 'high',
    providers: {
      claude: { command: 'claude', args: [], authMode: 'api' },
      codex: { command: 'codex', args: [], authMode: 'api' }
    }
  };
  const updated = mergeSettings(config, {
    provider: 'codex', model: 'sonnet', effort: 'max', authMode: 'api'
  });
  assert.equal(updated.provider, 'codex');
  assert.equal(updated.model, '');
  assert.equal(updated.effort, '');
  assert.equal(updated.providers.codex.authMode, 'subscription');
  assert.equal(validateProfile(updated).ok, true);
});

test('settings reject prototype-key providers without mutating Object.prototype', () => {
  const config = {
    provider: 'claude', providers: { claude: { command: 'claude', args: [] } }
  };
  const updated = mergeSettings(config, JSON.parse('{"provider":"__proto__"}'));
  assert.equal(updated.provider, 'claude');
  assert.equal(Object.prototype.authMode, undefined);
});
test('settings catalog never shells out to list unverified models', () => {
  const config = {
    provider: 'codex', model: 'gpt-5.6-sol',
    providers: {
      codex: { command: 'codex', models: ['gpt-5.1-codex'] },
      claude: { command: 'claude', models: ['opus'] }
    }
  };
  const discovered = catalogForSettings(config, { codex: ['gpt-5.6-sol'] });
  assert.deepEqual(discovered.providers.codex.reportedModels, ['gpt-5.6-sol']);
  assert.equal(discovered.providers.codex.models, undefined);
  assert.deepEqual(discovered.providers.claude.reportedModels, []);
  assert.deepEqual(config.providers.codex.models, ['gpt-5.1-codex']);
});

// RAI adds its MCP file without disabling native discovery or Chrome.
test('buildMcpArgs adds Claude session MCP without suppressing native integrations', () => {
  const configPath = '/tmp/mcp-session.json';
  assert.deepEqual(buildMcpArgs('claude', configPath), ['--mcp-config', configPath]);
});

test('Claude profile cannot add another MCP config beside the session rai server', () => {
  for (const profileArgs of [
    ['--mcp-config', '/other/servers.json'],
    ['--mcp-config=/other/servers.json']
  ]) {
    const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-mcp-test-'));
    assert.throws(() => buildCliLaunch({
      provider: 'claude', profile: { command: process.execPath, args: profileArgs },
      configDir, env: { RAI_BRIDGE_TOKEN: 'test-token', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL }
    }), BridgeConfigError);
    assert.deepEqual(readdirSync(configDir), []);
  }
});

test('launches both providers with account defaults and no overrides', () => {
  const env = { RAI_BRIDGE_TOKEN: 'test-token', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL };
  for (const provider of ['codex', 'claude', 'opencode']) {
    const launch = buildCliLaunch({
      provider, profile: { command: process.execPath, args: [] },
      model: 'ignored', effort: 'ignored', configDir: mkdtempSync(path.join(os.tmpdir(), 'rai-mcp-test-')),
      bridgeDir: mkdtempSync(path.join(os.tmpdir(), 'rai-bridge-test-')), env
    });
    assert.equal(launch.args.includes('--model'), false);
    assert.equal(launch.args.includes('--effort'), false);
    assert.equal(launch.args.some(arg => arg.includes('model_reasoning_effort')), false);
  }
});

test('Codex launch preserves native profile model and effort overrides', () => {
  const launch = buildCliLaunch({
    provider: 'codex',
    profile: {
      command: process.execPath,
      args: ['--model', 'stale-model', '--model=also-stale', '-c', 'model_reasoning_effort="high"', '--no-alt-screen']
    },
    configDir: mkdtempSync(path.join(os.tmpdir(), 'rai-mcp-test-')),
    bridgeDir: mkdtempSync(path.join(os.tmpdir(), 'rai-bridge-test-')),
    env: { RAI_BRIDGE_TOKEN: 'test-token', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL }
  });
  assert.equal(launch.args.includes('--model'), true);
  assert.equal(launch.args.some(arg => arg.includes('model_reasoning_effort')), true);
  assert.equal(launch.args.includes('--no-alt-screen'), true);
});

test('buildMcpArgs points Codex at the wrapper script, never Rscript directly', () => {
  const wrapperPath = '/tmp/.raistudio/mcp-123-abc.sh';
  const args = buildMcpArgs('codex', wrapperPath);
  assert.deepEqual(args, [
    '-c', `mcp_servers.rai.command="${wrapperPath}"`,
    '-c', 'mcp_servers.rai.args=[]',
    '-c', 'mcp_servers.rai.env.RAI_MCP_SERVER_NAME="rai"',
    '-c', 'mcp_servers.rai.env.RAI_MCP_PROVIDER="codex"',
    ...cliAllowedToolNames().flatMap(name => ['-c', `mcp_servers.rai.tools.${name.replace('mcp__rai__', '')}.approval_mode="approve"`])
  ]);
  assert.equal(args.includes('--mcp-config'), false);
  assert.equal(args.some(arg => arg.includes('Rscript')), false);
});

test('buildMcpArgs ignores unknown providers', () => {
  assert.deepEqual(buildMcpArgs('unknown', '/tmp/mcp-session.json'), []);
});

test('buildMcpArgs adds no argv for opencode (wiring happens via OPENCODE_CONFIG env instead)', () => {
  assert.deepEqual(buildMcpArgs('opencode', '/tmp/.raistudio/mcp-123-abc.json'), []);
});

test('creates an owner-only OpenCode config with a private bearer file reference', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-mcp-test-'));
  const bridgeDir = mkdtempSync(path.join(os.tmpdir(), 'rai-bridge-test-'));

  const { configPath, scriptPath } = createSessionOpenCodeConfig({
    configDir,
    bridgeDir,
    token: 'test-token', healthUrl: TEST_HEALTH_URL
  });

  assert.equal(scriptPath, path.join(bridgeDir, 'rai-native-mcp.js'));
  assert.equal(statSync(configDir).mode & 0o777, 0o700);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
    $schema: 'https://opencode.ai/config.json',
    instructions: [`${configPath}.instructions.md`],
    mcp: {
      rai: {
        type: 'local',
        command: [process.execPath, scriptPath],
        enabled: true,
        environment: { RAI_BRIDGE_TOKEN: `{file:${configPath}.token}`,
          RAI_MCP_SERVER_NAME: 'rai', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL }
      }
    }
  });
});

test('removeSessionMcpConfig also cleans up its own OpenCode session config', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-mcp-test-'));
  const { configPath } = createSessionOpenCodeConfig({ configDir, token: 'test-token', healthUrl: TEST_HEALTH_URL });

  assert.equal(existsSync(configPath), true);
  removeSessionMcpConfig(configPath, { configDir });
  assert.equal(existsSync(configPath), false);
});

test('OpenCode adds inline session MCP without replacing native config discovery or exposing bearer', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-mcp-test-'));
  let spawnOptions;
  let spawnArgs;

  const session = createCliSession({
    provider: 'opencode',
    profile: { command: 'opencode', args: [] },
    configDir,
    bridgeDir: '/tmp/rai-bridge',
    env: { RAI_BRIDGE_TOKEN: 'test-token', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL },
    spawn: (_command, args, options) => {
      spawnArgs = args;
      spawnOptions = options;
      return {};
    }
  });

  // Native file substitution reads the owner-only bearer; outer env/argv
  // carry only the reference. Original config discovery is not replaced.
  assert.equal(existsSync(session.configPath), true);
  assert.equal(statSync(session.configPath).mode & 0o777, 0o600);
  assert.equal(readFileSync(session.configPath, 'utf8').includes('test-token'), false);
  assert.equal(readFileSync(`${session.configPath}.token`, 'utf8'), 'test-token');
  assert.equal(spawnArgs.some(arg => arg.includes('test-token')), false);
  assert.equal(spawnOptions.env.OPENCODE_CONFIG, undefined);
  assert.equal(Object.values(JSON.parse(spawnOptions.env.OPENCODE_CONFIG_CONTENT).mcp).find(server => server.environment?.RAI_BRIDGE_TOKEN).environment.RAI_BRIDGE_TOKEN, `{file:${session.configPath}.token}`);
  assert.equal(spawnOptions.env.RAI_BRIDGE_TOKEN, undefined);
  assert.equal(spawnOptions.env.RAI_OWNER_TOKEN, undefined);
});

test('creates an owner-only session MCP config with bridge token', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-mcp-test-'));
  const bridgeDir = mkdtempSync(path.join(os.tmpdir(), 'rai-bridge-test-'));
  const legacyPath = path.join(configDir, 'mcp-stale.json');
  const activePath = path.join(configDir, `mcp-${process.pid}-active.json`);
  mkdirSync(path.join(configDir, 'unrelated-dir'), { recursive: true });
  writeFileSync(legacyPath, '{}');
  writeFileSync(activePath, '{}');
  writeFileSync(path.join(configDir, 'assistant.json'), '{}');

  const { configPath, scriptPath } = createSessionMcpConfig({
    configDir,
    bridgeDir,
    token: 'test-token', healthUrl: TEST_HEALTH_URL
  });

  assert.equal(scriptPath, path.join(bridgeDir, 'rai-native-mcp.js'));
  assert.equal(statSync(legacyPath).isFile(), true);
  assert.equal(statSync(activePath).isFile(), true);
  assert.equal(statSync(path.join(configDir, 'assistant.json')).isFile(), true);
  assert.equal(statSync(configDir).mode & 0o777, 0o700);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
    mcpServers: {
      rai: {
        command: process.execPath,
        args: [scriptPath],
        env: { RAI_BRIDGE_TOKEN_FILE: path.join(`${configPath}.session`, 'token'),
            RAI_MCP_SERVER_NAME: 'rai', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL }
      }
    }
  });
});

test('removes only a dead PID-scoped stale config', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-mcp-test-'));
  const deadPath = path.join(configDir, 'mcp-99999999-stale.json');
  writeFileSync(deadPath, '{}');

  createSessionMcpConfig({ configDir, token: 'test-token', healthUrl: TEST_HEALTH_URL });

  assert.equal(existsSync(deadPath), false);
});

test('macOS CLI sessions run the provider directly; caffeinate is an independent guard', { skip: process.platform !== 'darwin' }, () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-mcp-test-'));
  let spawnedCommand;
  let spawnedArgs;

  const session = createCliSession({
    provider: 'claude',
    profile: { command: 'claude', args: [] },
    configDir,
    bridgeDir: '/tmp/rai-bridge',
    env: { RAI_BRIDGE_TOKEN: 'test-token', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL },
    spawn: (command, args) => {
      spawnedCommand = command;
      spawnedArgs = args;
      return { pid: 4321 };
    }
  });

  let guardCommand;
  let guardArgs;
  let guardEnv;
  const guard = createCaffeinateGuard({
    pid: session.term.pid,
    env: { RAI_BRIDGE_TOKEN: 'test-token', RAI_OWNER_TOKEN: 'owner-token', PATH: '/usr/bin' },
    spawn: (command, args, options) => {
      guardCommand = command;
      guardArgs = args;
      guardEnv = options.env;
      return { kill() {} };
    }
  });

  assert.equal(path.basename(spawnedCommand), 'claude');
  assert.equal(spawnedArgs.includes('-d'), false);
  assert.equal(guardCommand, 'caffeinate');
  assert.deepEqual(guardArgs, ['-d', '-i', '-s', '-u', '-t', '43200', '-w', '4321']);
  assert.equal(guardEnv.RAI_BRIDGE_TOKEN, undefined);
  assert.equal(guardEnv.RAI_OWNER_TOKEN, undefined);
  assert.equal(guardEnv.PATH, '/usr/bin');
  assert.ok(guard);
  removeSessionMcpConfig(session.configPath, { configDir });
});

test('caffeinate:false skips the wrapper even on macOS', { skip: process.platform !== 'darwin' }, () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-mcp-test-'));
  let spawnedCommand;

  const session = createCliSession({
    provider: 'claude',
    profile: { command: 'claude', args: [] },
    configDir,
    bridgeDir: '/tmp/rai-bridge',
    env: { RAI_BRIDGE_TOKEN: 'test-token', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL },
    caffeinate: false,
    spawn: (command) => {
      spawnedCommand = command;
      return {};
    }
  });

  assert.equal(path.basename(spawnedCommand), 'claude');
  removeSessionMcpConfig(session.configPath, { configDir });
});

// The native settings dialog and the caffeinate checkbox both work by writing
// this file, and the CONFIG_FILE watch re-reads it through loadConfig(). If
// backfillProviderDefaults forced either flag on, that re-read would rewrite the
// box the user just unchecked and leave the switch permanently dead. Both
// launch defaults belong at bridge startup (server.js), never in this path.
test('backfill preserves stored caffeinate and inert approval compatibility booleans', () => {
  const off = backfillProviderDefaults({
    providers: {}, caffeinate: false, autoApproveReadOnly: false
  });
  assert.equal(off.caffeinate, false);
  assert.equal(off.autoApproveReadOnly, false);

  // Absent keys still get the on-by-default launch value.
  const absent = backfillProviderDefaults({ providers: {} });
  assert.equal(absent.caffeinate, true);
  assert.equal(absent.autoApproveReadOnly, true);

  // A non-boolean is treated as absent rather than as a truthy opt-in.
  const bogus = backfillProviderDefaults({
    providers: {}, caffeinate: 'no', autoApproveReadOnly: 0
  });
  assert.equal(bogus.caffeinate, true);
  assert.equal(bogus.autoApproveReadOnly, true);
});

test('the shipped defaults keep caffeinate on and approval compatibility true', () => {
  assert.equal(DEFAULT_CONFIG.caffeinate, true);
  assert.equal(DEFAULT_CONFIG.autoApproveReadOnly, true);
});

// --- provider-CLI tool allowlist -------------------------------------------
//
// Claude Code puts its own "Do you want to proceed?" prompt in front of every
// MCP tool call. The Assistant pane's terminal is a headless pty that cannot
// answer it, so any tool left off --allowedTools deadlocks instead of running.
// The list used to be hand-written as just run_r + get_run_result and fell a
// dozen tools behind, which is why it is now derived from the tool definitions.

test('the CLI allowlist covers every bounded read-only connector', () => {
  const allowed = cliAllowedToolNames();

  // Named explicitly, not derived, so a connector silently disappearing from
  // the tool list cannot make this pass vacuously.
  for (const name of [
    'run_r',                        // gated natively by the approval card
    'get_run_result',               // Console results
    'get_debug_info',               // Console debug context
    'get_active_document_context',  // active open buffer
    'list_open_documents',          // open buffers
    'read_open_document',           // open buffer contents
    'get_project_context',          // project manifest (active project only)
    'get_environment_summary',      // bounded Environment / Data Viewer summary
    'get_plot_history',             // plot history
    'get_plot_image',               // plot image
    'get_viewer_state',             // Viewer state
  ]) {
    assert.ok(allowed.includes(`mcp__rai__${name}`), `${name} is missing from --allowedTools`);
  }
});

test('edit_document is allowlisted like every other tool (approval gate disabled 2026-08-09)', () => {
  assert.deepEqual(APPROVAL_GATED_TOOL_NAMES, []);
  assert.equal(cliAllowedToolNames().includes('mcp__rai__edit_document'), true);
});

test('the allowlist is derived from the tool list, so a new connector cannot be left off', () => {
  const expected = nativeTools
    .map((tool) => tool.name)
    .filter((name) => !APPROVAL_GATED_TOOL_NAMES.includes(name))
    .map((name) => `mcp__rai__${name}`);
  assert.deepEqual(cliAllowedToolNames(), expected);

  // Every allowlisted name is qualified for this server only -- never a bare
  // tool name, and never another server's namespace.
  for (const name of cliAllowedToolNames())
    assert.match(name, /^mcp__rai__[a-z_]+$/);
});

// Asserts the exact argv the real `claude` binary would be exec'd with. The
// spawn is stubbed so this stays hermetic, but the vector under test is the
// real launch path (createCliSession), not a reconstruction of it.
test('the claude launch argv passes the full allowlist and no blanket bypass', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-mcp-test-'));
  let spawnedArgs;

  const session = createCliSession({
    provider: 'claude',
    profile: { command: 'claude', args: [] },
    configDir,
    bridgeDir: '/tmp/rai-bridge',
    env: { RAI_BRIDGE_TOKEN: 'test-token', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL },
    caffeinate: false,
    spawn: (command, args) => {
      spawnedArgs = args;
      return {};
    }
  });

  const flagIndex = spawnedArgs.indexOf('--allowedTools');
  assert.ok(flagIndex >= 0, '--allowedTools missing from the launch argv');

  // The flag's values are every element up to the next flag.
  const passed = [];
  for (let i = flagIndex + 1; i < spawnedArgs.length && !spawnedArgs[i].startsWith('--'); i++)
    passed.push(spawnedArgs[i]);
  const serverName = Object.keys(JSON.parse(readFileSync(session.configPath)).mcpServers)[0];
  assert.deepEqual(passed, cliAllowedToolNames().map(name => name.replace('mcp__rai__', `mcp__${serverName}__`)));
  assert.equal(passed.includes(`mcp__${serverName}__edit_document`), true);

  // The bypass stays scoped: never the blanket escape hatch.
  assert.equal(spawnedArgs.includes('--dangerously-skip-permissions'), false);

  removeSessionMcpConfig(session.configPath, { configDir });
});

test('missing bridge token creates no config', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-mcp-test-'));

  assert.throws(
    () => createSessionMcpConfig({ configDir }),
    /RAI_BRIDGE_TOKEN is required/
  );
  assert.deepEqual(readdirSync(configDir), []);
});

test('missing bridge token prevents PTY spawn and config creation', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-mcp-test-'));
  let spawnCalls = 0;

  assert.throws(() => createCliSession({
    provider: 'claude',
    profile: { command: 'claude', args: [] },
    configDir,
    env: {},
    spawn: () => { spawnCalls += 1; }
  }), BridgeConfigError);
  assert.equal(spawnCalls, 0);
  assert.deepEqual(readdirSync(configDir), []);
});

test('creates an owner-only Codex wrapper script with the bridge token', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-mcp-test-'));
  const bridgeDir = mkdtempSync(path.join(os.tmpdir(), 'rai-bridge-test-'));

  const { configPath, scriptPath } = createSessionCodexWrapper({
    configDir,
    bridgeDir,
    token: 'test-token', healthUrl: TEST_HEALTH_URL
  });

  assert.equal(scriptPath, path.join(bridgeDir, 'rai-native-mcp.js'));
  assert.equal(statSync(configDir).mode & 0o777, 0o700);
  assert.equal(statSync(configPath).mode & 0o777, 0o700);
  const contents = readFileSync(configPath, 'utf8');
  assert.match(contents, /^#!\/bin\/sh$/m);
  assert.match(contents, /export RAI_BRIDGE_TOKEN='test-token'/);
  assert.match(contents, new RegExp(`export RAI_SESSION_HEALTH_URL='${TEST_HEALTH_URL}'`));
  assert.match(contents, new RegExp(`exec '${process.execPath}' '${scriptPath}' "\\$@"`));
});

test('Codex launches via its wrapper script and never inherits the bridge token itself', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-mcp-test-'));
  let spawnOptions;
  let spawnArgs;

  const session = createCliSession({
    provider: 'codex',
    profile: { command: 'codex', args: [] },
    configDir,
    bridgeDir: '/tmp/rai-bridge',
    env: { RAI_BRIDGE_TOKEN: 'test-token', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL },
    spawn: (_command, args, options) => {
      spawnArgs = args;
      spawnOptions = options;
      return {};
    }
  });

  // A per-session wrapper was created and handed to Codex on the command
  // line only as a path -- never the token itself.
  assert.equal(existsSync(session.configPath), true);
  assert.equal(statSync(session.configPath).mode & 0o777, 0o700);
  assert.equal(spawnArgs.some(arg => arg.includes('test-token')), false);
  assert.equal(spawnArgs.some(arg => arg.includes(session.configPath)), true);

  // Codex's own process env must not carry the token at all.
  assert.equal(spawnOptions.env.RAI_BRIDGE_TOKEN, undefined);
});

test('Claude launches via its mcp-config file and never inherits the bridge token itself', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-mcp-test-'));
  let spawnOptions;
  let spawnArgs;

  const session = createCliSession({
    provider: 'claude',
    profile: { command: 'claude', args: [] },
    configDir,
    bridgeDir: '/tmp/rai-bridge',
    env: { RAI_BRIDGE_TOKEN: 'test-token', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL },
    spawn: (_command, args, options) => {
      spawnArgs = args;
      spawnOptions = options;
      return {};
    }
  });

  // Only the connector reads the private token file
  assert.equal(existsSync(session.configPath), true);
  assert.doesNotMatch(readFileSync(session.configPath, 'utf8'), /test-token/);
  assert.equal(readFileSync(path.join(`${session.configPath}.session`, 'token'), 'utf8'), 'test-token');
  const distillerIndex = spawnArgs.indexOf('--append-system-prompt-file');
  assert.notEqual(distillerIndex, -1);
  assert.equal(spawnArgs[distillerIndex + 1].endsWith('.instructions.md'), true);
  assert.equal(spawnOptions.env.RAI_BRIDGE_TOKEN, undefined);
});

test('removeSessionMcpConfig also cleans up its own Codex wrapper script', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-mcp-test-'));
  const { configPath } = createSessionCodexWrapper({ configDir, token: 'test-token', healthUrl: TEST_HEALTH_URL });

  assert.equal(existsSync(configPath), true);
  removeSessionMcpConfig(configPath, { configDir });
  assert.equal(existsSync(configPath), false);
});

test('Claude config is removed when PTY spawn throws', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-mcp-test-'));

  assert.throws(() => createCliSession({
    provider: 'claude',
    profile: { command: 'claude', args: [] },
    configDir,
    env: { RAI_BRIDGE_TOKEN: 'test-token', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL },
    spawn: () => { throw new Error('spawn failed'); }
  }), /spawn failed/);
  assert.deepEqual(readdirSync(configDir), []);
});

test('removes only its own PID-scoped session config', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-mcp-test-'));
  const activePath = path.join(configDir, `mcp-${process.pid}-other.json`);
  writeFileSync(activePath, '{}');
  const { configPath } = createSessionMcpConfig({ configDir, token: 'test-token', healthUrl: TEST_HEALTH_URL });

  removeSessionMcpConfig(configPath, { configDir });

  assert.equal(existsSync(configPath), false);
  assert.equal(existsSync(activePath), true);
});

test('mcp.js has no node-pty or child_process import (buildCliLaunch stays pure)', () => {
  const source = readFileSync(fileURLToPath(new URL('../mcp.js', import.meta.url)), 'utf8');
  // Comments are allowed to mention pty/child_process (e.g. explaining why
  // buildCliLaunch avoids them) -- only an actual import/require is a leak.
  assert.equal(/^\s*import .*['"]node-pty['"]/m.test(source), false);
  assert.equal(/^\s*import .*['"](node:)?child_process['"]/m.test(source), false);
  assert.equal(/require\(\s*['"](node-pty|(node:)?child_process)['"]\s*\)/.test(source), false);
});

test('buildCliLaunch returns the expected launch shape for claude, with the token scrubbed', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-mcp-test-'));
  const bridgeDir = mkdtempSync(path.join(os.tmpdir(), 'rai-bridge-test-'));
  const profile = { command: process.execPath, args: [], modelFlag: '--model' };

  const launch = buildCliLaunch({
    provider: 'claude',
    profile,
    model: 'opus',
    configDir,
    bridgeDir,
    env: { RAI_BRIDGE_TOKEN: 'test-token', RAI_OWNER_TOKEN: 'test-token', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL }
  });

  assert.deepEqual(Object.keys(launch).sort(), ['args', 'command', 'configPath', 'env']);
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.args.slice(0, 2), [
    '--append-system-prompt-file', `${launch.configPath}.instructions.md`
  ]);
  const mcpConfigIndex = launch.args.indexOf('--mcp-config');
  assert.notEqual(mcpConfigIndex, -1);
  assert.equal(launch.args[mcpConfigIndex + 1], launch.configPath);
  assert.equal(existsSync(launch.configPath), true);
  assert.equal(launch.args.includes('--strict-mcp-config'), false);
  assert.equal(launch.args.includes('--no-chrome'), false);
  const distillerIndex = launch.args.indexOf('--append-system-prompt-file');
  assert.notEqual(distillerIndex, -1);
  assert.equal(launch.args[distillerIndex + 1].endsWith('.instructions.md'), true);

  // Claude Code's own MCP tool-approval prompt is bypassed for exactly the rai
  // MCP server's own tools -- never a blanket --dangerously-skip-permissions.
  // Approval gating is disabled entirely (2026-08-09 evening): the native
  // session auto-grants every proposal unconditionally, so every tool
  // including edit_document is derived onto this allowlist -- a second CLI
  // prompt in front of an already-auto-approved native card would be dead
  // friction.
  const allowedToolsIndex = launch.args.indexOf('--allowedTools');
  assert.notEqual(allowedToolsIndex, -1);
  assert.deepEqual(
    launch.args.slice(allowedToolsIndex + 1, allowedToolsIndex + 1 + cliAllowedToolNames().length),
    cliAllowedToolNames().map(name => name.replace('mcp__rai__', `mcp__${Object.keys(JSON.parse(readFileSync(launch.configPath)).mcpServers)[0]}__`))
  );
  assert.equal(launch.args.includes(`mcp__${Object.keys(JSON.parse(readFileSync(launch.configPath)).mcpServers)[0]}__edit_document`), true);
  assert.equal(launch.args.includes('--dangerously-skip-permissions'), false);
  assert.equal(launch.args.includes('--allow-dangerously-skip-permissions'), false);

  // The token never leaves buildCliLaunch in the returned env -- under either
  // of its two names (RAI_OWNER_TOKEN is the same secret; ensureSessionAuthReady
  // sets it process-wide on the rsession side, so it can reach this env too).
  assert.equal(launch.env.RAI_BRIDGE_TOKEN, undefined);
  assert.equal(launch.env.RAI_OWNER_TOKEN, undefined);
  assert.equal(launch.env.TERM, 'xterm-256color');
});

test('buildCliLaunch gives the loopback inspector URL only to the MCP child', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-mcp-test-'));
  const bridgeDir = mkdtempSync(path.join(os.tmpdir(), 'rai-bridge-test-'));
  const inspectorUrl = 'http://127.0.0.1:8790/internal/run-inspector';
  const launch = buildCliLaunch({
    provider: 'claude',
    profile: { command: process.execPath, args: [] },
    configDir,
    bridgeDir,
    env: {
      RAI_BRIDGE_TOKEN: 'test-token',
      RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL,
      RAI_RUN_INSPECTOR_URL: inspectorUrl
    }
  });

  const mcpConfig = JSON.parse(readFileSync(launch.configPath, 'utf8'));
  assert.equal(Object.values(mcpConfig.mcpServers)[0].env.RAI_RUN_INSPECTOR_URL, inspectorUrl);
  assert.equal(launch.env.RAI_RUN_INSPECTOR_URL, undefined);
  assert.equal(JSON.stringify(launch.args).includes(inspectorUrl), false);
});

test('buildCliLaunch returns the expected launch shape for codex, with the token scrubbed', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-mcp-test-'));
  const bridgeDir = mkdtempSync(path.join(os.tmpdir(), 'rai-bridge-test-'));
  const profile = { command: process.execPath, args: [] };

  const launch = buildCliLaunch({
    provider: 'codex',
    profile,
    model: undefined,
    configDir,
    bridgeDir,
    env: { RAI_BRIDGE_TOKEN: 'test-token', RAI_OWNER_TOKEN: 'test-token', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL }
  });

  assert.deepEqual(Object.keys(launch).sort(), ['args', 'command', 'configPath', 'env']);
  assert.equal(launch.command, process.execPath);
  const namespace = launch.args.find(v => /^mcp_servers\..*\.command=/.test(v)).split('.')[1];
  assert.deepEqual(launch.args, [
    '-c', `developer_instructions=${JSON.stringify(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'RAI-Assistant.md'), 'utf8').replaceAll('{{RAI_MCP_SERVER}}', `mcp__${namespace}__*`))}`,
    '-c', `mcp_servers.${namespace}.command="${launch.configPath}"`,
    '-c', `mcp_servers.${namespace}.args=[]`,
    '-c', `mcp_servers.${namespace}.env.RAI_MCP_SERVER_NAME="${namespace}"`,
    '-c', `mcp_servers.${namespace}.env.RAI_MCP_PROVIDER="codex"`,
    ...cliAllowedToolNames().flatMap(name => ['-c', `mcp_servers.${namespace}.tools.${name.replace('mcp__rai__', '')}.approval_mode="approve"`])
  ]);
  assert.equal(existsSync(launch.configPath), true);
  assert.equal(statSync(launch.configPath).mode & 0o777, 0o700);

  // The token never leaves buildCliLaunch in the returned env, under either name.
  assert.equal(launch.env.RAI_BRIDGE_TOKEN, undefined);
  assert.equal(launch.env.RAI_OWNER_TOKEN, undefined);
  assert.equal(launch.env.TERM, 'xterm-256color');
});

test('managed Claude launch leaves native permission policy unchanged', () => {
  for (const autoApprove of [true, false]) {
    const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-native-policy-'));
    const env = Object.freeze({ RAI_BRIDGE_TOKEN: 'test-token', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL });
    const launch = buildCliLaunch({ provider: 'claude', profile: { command: process.execPath, args: [] },
      autoApprove, configDir, env });
    try {
      for (const flag of ['--disallowedTools', '--permission-mode',
        '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'])
        assert.equal(launch.args.includes(flag), false, `${flag} must remain native policy`);
      assert.equal(launch.args.includes('--allowedTools'), true);
      const contents = JSON.parse(readFileSync(launch.configPath, 'utf8'));
      assert.equal(Object.keys(contents.mcpServers).length, 1);
      assert.match(Object.keys(contents.mcpServers)[0], /^rai_studio_session_[a-f0-9]{32}$/);
      assert.equal(Object.values(contents.mcpServers)[0].env.RAI_BRIDGE_TOKEN, undefined);
      assert.equal(readFileSync(Object.values(contents.mcpServers)[0].env.RAI_BRIDGE_TOKEN_FILE, 'utf8'), 'test-token');
      assert.equal(launch.env.RAI_BRIDGE_TOKEN, undefined);
      assert.equal(env.RAI_BRIDGE_TOKEN, 'test-token');
    } finally { removeSessionMcpConfig(launch.configPath, { configDir }); }
  }
});

test('managed Codex launch leaves native sandbox and approval policy unchanged', () => {
  for (const autoApprove of [true, false]) {
    const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-native-policy-'));
    const launch = buildCliLaunch({ provider: 'codex', profile: { command: process.execPath, args: [] },
      autoApprove, configDir, env: { RAI_BRIDGE_TOKEN: 'test-token', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL } });
    try {
      for (const flag of ['--sandbox', '--ask-for-approval', '--yolo', '--full-auto',
        '--dangerously-bypass-approvals-and-sandbox'])
        assert.equal(launch.args.includes(flag), false, `${flag} must remain native policy`);
      assert.equal(launch.args.some(value => value.includes('tools.run_r.approval_mode="approve"')), true);
      assert.ok(launch.args.some(v => /^mcp_servers\.rai_studio_session_[a-f0-9]+\.command=/.test(v) && v.endsWith(JSON.stringify(launch.configPath))));
      assert.equal(launch.env.RAI_BRIDGE_TOKEN, undefined);
    } finally { removeSessionMcpConfig(launch.configPath, { configDir }); }
  }
});

test('managed OpenCode launch preserves native config and policy without exposing its bearer', () => {
  for (const autoApprove of [true, false]) {
    const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-native-policy-'));
    const nativeInline = { theme: 'dark', permission: { '*': 'ask', bash: 'ask', edit: 'deny' },
      instructions: ['native-guidance.md'], mcp: { existing: { type: 'local', command: ['native-server'] } } };
    const env = Object.freeze({ RAI_BRIDGE_TOKEN: 'test-token', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL, HOME: configDir,
      OPENCODE_CONFIG: '/existing/custom.jsonc', OPENCODE_CONFIG_CONTENT: JSON.stringify(nativeInline) });
    const launch = buildCliLaunch({ provider: 'opencode', profile: { command: process.execPath, args: [] },
      autoApprove, configDir, env });
    try {
      assert.equal(launch.args.includes('--auto'), false);
      assert.equal(launch.env.OPENCODE_CONFIG, env.OPENCODE_CONFIG);
      const inline = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
      assert.deepEqual(inline.permission, nativeInline.permission);
      assert.deepEqual(inline.mcp.existing, nativeInline.mcp.existing);
      assert.equal(inline.theme, nativeInline.theme);
      assert.equal(inline.instructions[0], nativeInline.instructions[0]);
      assert.ok(inline.instructions.includes(`${launch.configPath}.instructions.md`));
      const sessionName = Object.keys(inline.mcp).find(name => name.startsWith('rai_studio_session_'));
      const instructions = readFileSync(`${launch.configPath}.instructions.md`, 'utf8');
      assert.ok(instructions.includes(sessionName));
      assert.equal(instructions.includes(`mcp__${sessionName}__*`), false, 'OpenCode shows the server name, not the Claude tool form');
      assert.equal(inline.command['rai-audit'].template.includes(sessionName), true, 'the audit command names this session server');
      assert.match(inline.command['rai-audit'].template, /get_audit_workflow/);
      assert.equal(inline.mcp[sessionName].environment.RAI_MCP_PROVIDER, 'opencode');
      assert.equal(Object.values(inline.mcp).find(server => server.environment?.RAI_BRIDGE_TOKEN).environment.RAI_BRIDGE_TOKEN, `{file:${launch.configPath}.token}`);
      assert.equal(readFileSync(`${launch.configPath}.token`, 'utf8'), 'test-token');
      assert.equal(statSync(`${launch.configPath}.token`).mode & 0o777, 0o600);
      assert.equal(JSON.stringify({ args: launch.args, env: launch.env }).includes('test-token'), false);
      assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT), nativeInline);
    } finally { removeSessionMcpConfig(launch.configPath, { configDir }); }
    assert.equal(existsSync(`${launch.configPath}.token`), false);
  }
});

// Native-freedom requirements supersede the former RAI-imposed engine clamp.
test('RAI auto-approval ON never selects native permission or sandbox modes', () => {
  for (const provider of ['claude', 'codex', 'opencode']) {
    const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-fullauto-'));
    const launch = buildCliLaunch({ provider, profile: { command: process.execPath, args: [] }, autoApprove: true,
      configDir, env: { RAI_BRIDGE_TOKEN: 'test-token', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL } });
    try {
      assert.equal(launch.env.RAI_BRIDGE_TOKEN, undefined);
      for (const flag of ['--disallowedTools', '--permission-mode', '--sandbox', '--ask-for-approval', '--auto'])
        assert.equal(launch.args.includes(flag), false);
      if (provider === 'claude') assert.ok(launch.args.includes('--allowedTools'));
      else if (provider === 'codex') assert.ok(launch.args.some(value => value.includes('tools.run_r.approval_mode="approve"')));
      else {
        const inline = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
        assert.equal(inline.permission, undefined);
        assert.equal(Object.values(inline.mcp).find(server => server.environment?.RAI_BRIDGE_TOKEN).type, 'local');
        assert.equal(JSON.parse(readFileSync(launch.configPath, 'utf8')).permission, undefined);
      }
    } finally { removeSessionMcpConfig(launch.configPath, { configDir }); }
  }
});

test('legacy false cannot disable scoped RAI preapproval or change native policy', () => {
  for (const provider of ['claude', 'codex', 'opencode']) {
    const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-fullauto-off-'));
    const launch = buildCliLaunch({ provider, profile: { command: process.execPath, args: [] }, autoApprove: false,
      configDir, env: { RAI_BRIDGE_TOKEN: 'test-token', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL } });
    try {
      for (const flag of ['--permission-mode', '--disallowedTools', '--sandbox', '--ask-for-approval', '--auto'])
        assert.equal(launch.args.includes(flag), false);
      if (provider === 'claude') {
        const index = launch.args.indexOf('--allowedTools');
        assert.notEqual(index, -1);
        assert.deepEqual(launch.args.slice(index + 1, index + 1 + cliAllowedToolNames().length), cliAllowedToolNames().map(name => name.replace('mcp__rai__', `mcp__${Object.keys(JSON.parse(readFileSync(launch.configPath)).mcpServers)[0]}__`)));
      } else if (provider === 'codex') {
        assert.deepEqual(launch.args.filter(value => value.includes('approval_mode=')),
          cliAllowedToolNames().map(name => `mcp_servers.${launch.args.find(v => /^mcp_servers\..*\.command=/.test(v)).split('.')[1]}.tools.${name.replace('mcp__rai__', '')}.approval_mode="approve"`));
      }
      if (provider === 'opencode') {
        const inline = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
        assert.equal(inline.permission, undefined);
        assert.equal(Object.values(inline.mcp).find(server => server.environment?.RAI_BRIDGE_TOKEN).type, 'local');
      }
    } finally { removeSessionMcpConfig(launch.configPath, { configDir }); }
  }
});

test('OpenCode preserves inherited native inline permission rules without injecting RAI rules', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-inline-policy-'));
  const native = { theme: 'dark', permission: { bash: 'allow', edit: 'allow', webfetch: 'ask' } };
  const launch = buildCliLaunch({ provider: 'opencode', profile: { command: process.execPath, args: [] },
    autoApprove: true, configDir, env: { RAI_BRIDGE_TOKEN: 'test-token', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(native) } });
  try {
    const inline = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(inline.theme, native.theme);
    assert.deepEqual(inline.permission, native.permission);
    assert.equal(inline.permission.rai_edit_document, undefined);
  } finally { removeSessionMcpConfig(launch.configPath, { configDir }); }
});

test('OpenCode preserves malformed inherited config without creating session artifacts', () => {
  for (const value of ['{', 'null', '[]', '{"mcp":[]}', '{"instructions":"native.md"}', '{"command":"native.md"}', '{"command":[]}']) {
    const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-opencode-input-'));
    const env = Object.freeze({ RAI_BRIDGE_TOKEN: 'test-token', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL,
      OPENCODE_CONFIG: '/existing/native.jsonc', OPENCODE_CONFIG_CONTENT: value });
    const launch = buildCliLaunch({ provider: 'opencode', profile: { command: process.execPath, args: [] }, configDir, env });
    assert.equal(launch.env.OPENCODE_CONFIG_CONTENT, value);
    assert.equal(launch.configPath, undefined);
    assert.deepEqual(readdirSync(configDir), []);
    assert.equal(env.OPENCODE_CONFIG_CONTENT, value);
  }
});

test('OpenCode preserves native permission shorthand without adding an approval map', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-opencode-policy-'));
  const launch = buildCliLaunch({ provider: 'opencode', profile: { command: process.execPath, args: [] }, autoApprove: true,
    configDir, env: { RAI_BRIDGE_TOKEN: 'test-token', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: 'deny' }) } });
  try { assert.equal(JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT).permission, 'deny'); }
  finally { removeSessionMcpConfig(launch.configPath, { configDir }); }
});

test('OpenCode spawn failure removes its session config and private bearer', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-opencode-spawn-'));
  assert.throws(() => createCliSession({ provider: 'opencode', profile: { command: process.execPath, args: [] },
    configDir, globalPrompt: 'Keep source changes scoped.',
    env: { RAI_BRIDGE_TOKEN: 'test-token', RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL },
    spawn: () => { throw new Error('native spawn failed'); } }), /native spawn failed/);
  assert.deepEqual(readdirSync(configDir), []);
});

test('OpenCode startup removes only dead-owner token and temporary artifacts', () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-opencode-stale-'));
  const dead = ['mcp-99999999-old.json', 'mcp-99999999-old.json.token', 'mcp-99999999-old.json.tmp',
    'mcp-99999999-old.json.instructions.md'];
  const active = path.join(configDir, `mcp-${process.pid}-other.json.token`);
  for (const name of dead) writeFileSync(path.join(configDir, name), 'unit-artifact', { mode: 0o600 });
  writeFileSync(active, 'active-unit-artifact', { mode: 0o600 });
  const session = createSessionOpenCodeConfig({ configDir, token: 'test-token', healthUrl: TEST_HEALTH_URL });
  try {
    for (const name of dead) assert.equal(existsSync(path.join(configDir, name)), false);
    assert.equal(readFileSync(active, 'utf8'), 'active-unit-artifact');
  } finally { removeSessionMcpConfig(session.configPath, { configDir }); }
  assert.equal(existsSync(active), true);
});

test('OpenCode publish failure removes its owned config bearer and instructions', (t) => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'rai-opencode-failure-'));
  const original = fs.chmodSync;
  const fault = t.mock.method(fs, 'chmodSync', (target, mode) => {
    if (String(target).startsWith(configDir) && String(target).endsWith('.json'))
      throw Object.assign(new Error('config publish failure'), { code: 'EIO' });
    return original(target, mode);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => createSessionOpenCodeConfig({ configDir, token: 'test-token', healthUrl: TEST_HEALTH_URL,
      globalPrompt: 'Keep source changes scoped.' }), /config publish failure/);
    assert.deepEqual(readdirSync(configDir), []);
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
});

test('companion guidance separates native source saves from guarded RAI tools', () => {
  const text = readFileSync(new URL('../prompts/RAI-Assistant.md', import.meta.url), 'utf8');
  assert.match(text, /Native source edits and disk saves/);
  assert.match(text, /RAI saves its own applied edits to disk automatically and no setting turns this off/);
  assert.match(text, /strict proposal to `run_r`/);
  assert.doesNotMatch(text, /Use the terminal for harness diagnostics and non-RStudio tasks only/);
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const hint = html.match(/id="settings-rai-policy-hint"[^>]*>([^<]*)</)?.[1];
  assert.match(hint, /Native CLI permissions remain unchanged/);
  assert.match(hint, /approved automatically/);
});

test('shellQuote escapes an embedded single quote', () => {
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test('shellQuote wraps a value containing a space', () => {
  assert.equal(shellQuote('hello world'), "'hello world'");
});
