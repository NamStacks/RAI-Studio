import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCliLaunch, createCliSession, removeSessionMcpConfig } from '../mcp.js';
import { handleAuditTool, renderSessionInstructions } from '../rai-audit-mcp.js';
import { openCodeSupportsStandalone } from '../provider-status.js';
import { skillHint } from '../public/skill-hints.js';
import { skillSourceStatus } from '../skill-status.js';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = file => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const ENV = { PATH: process.env.PATH, RAI_BRIDGE_TOKEN: 'assistants-test-token', RAI_SESSION_HEALTH_URL: 'http://127.0.0.1:19090/health' };
const temp = prefix => mkdtempSync(path.join(os.tmpdir(), prefix));

// Every launch gets its own empty HOME so a skill the developer owns never changes the result.
function withDirs(run) {
  const configDir = temp('rai-assistants-config-');
  const home = temp('rai-assistants-home-');
  const project = temp('rai-assistants-project-');
  try { return run({ configDir, home, project }); }
  finally { for (const dir of [configDir, home, project]) rmSync(dir, { recursive: true, force: true }); }
}

function grokLaunch({ configDir, home, project }) {
  return buildCliLaunch({ provider: 'grok', profile: { command: 'grok', args: [] }, configDir, cwd: project, env: { ...ENV, HOME: home } });
}

function openCodeLaunch({ configDir, home, project }, { inline, args = [], standalone, env = {} } = {}) {
  return buildCliLaunch({
    provider: 'opencode', profile: { command: 'opencode', args }, configDir, cwd: project, openCodeStandalone: standalone,
    env: { ...ENV, HOME: home, ...(inline ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(inline) } : {}), ...env }
  });
}

test('the audit text names the session server in the form each assistant shows', () => {
  const text = 'tools `{{RAI_MCP_SERVER}}`';
  assert.equal(renderSessionInstructions(text, 'srv'), 'tools `mcp__srv__*`');
  assert.equal(renderSessionInstructions(text, 'srv', 'claude'), 'tools `mcp__srv__*`');
  assert.equal(renderSessionInstructions(text, 'srv', 'codex'), 'tools `mcp__srv__*`');
  assert.equal(renderSessionInstructions(text, 'srv', 'opencode'), 'tools `srv`');
  assert.equal(renderSessionInstructions(text, 'srv', 'grok'), 'tools `srv`');
  assert.equal(renderSessionInstructions(text, 'srv', 'something-new'), 'tools `mcp__srv__*`');
  assert.throws(() => renderSessionInstructions(text, 'a/b', 'grok'), /invalid RAI MCP server name/);
});

test('get_audit_workflow renders for the assistant that started the connector', async () => {
  const saved = { name: process.env.RAI_MCP_SERVER_NAME, provider: process.env.RAI_MCP_PROVIDER };
  try {
    process.env.RAI_MCP_SERVER_NAME = 'rai_studio_session_abc';
    for (const [provider, expected] of [[undefined, 'mcp__rai_studio_session_abc__*'], ['claude', 'mcp__rai_studio_session_abc__*'], ['codex', 'mcp__rai_studio_session_abc__*'], ['opencode', 'rai_studio_session_abc'], ['grok', 'rai_studio_session_abc']]) {
      if (provider === undefined) delete process.env.RAI_MCP_PROVIDER; else process.env.RAI_MCP_PROVIDER = provider;
      const { instructions } = await handleAuditTool('get_audit_workflow', {}, {}, {});
      assert.ok(instructions.includes(`\`${expected}\``), `${provider} names the server in its own form`);
      assert.equal(instructions.includes('{{RAI_MCP_SERVER}}'), false);
      assert.equal(instructions.includes('mcp__rai_studio_session_abc__*'), expected.startsWith('mcp__'), `${provider} tool form`);
    }
  } finally {
    for (const [key, value] of [['RAI_MCP_SERVER_NAME', saved.name], ['RAI_MCP_PROVIDER', saved.provider]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('Grok gets /rai-audit from a skill in its own session folder, rendered for Grok tool names', () => withDirs(dirs => {
  const run = grokLaunch(dirs);
  const sessionDir = run.args[run.args.indexOf('--cwd') + 1];
  const skillDir = path.join(sessionDir, '.grok', 'skills', 'rai-audit');
  const skill = readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  const toml = readFileSync(path.join(sessionDir, '.grok', 'config.toml'), 'utf8');
  const serverName = /^\[mcp_servers\.(rai_studio_session_[a-f0-9]{32})\]$/m.exec(toml)[1];
  assert.match(skill, /^---\nname: rai-audit\n/);
  assert.ok(skill.includes(serverName));
  assert.equal(skill.includes(`mcp__${serverName}__*`), false, 'Grok shows <server>__<tool>');
  assert.equal(skill.includes('{{RAI_MCP_SERVER}}'), false);
  assert.equal(readFileSync(path.join(skillDir, 'scientific-checks.md'), 'utf8'), read('skills/rai-audit/scientific-checks.md'));
  assert.deepEqual(readdirSync(skillDir).sort(), ['SKILL.md', 'scientific-checks.md']);
  assert.match(toml, /^RAI_MCP_PROVIDER = "grok"$/m);
  const agents = readFileSync(path.join(sessionDir, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes(serverName));
  assert.equal(agents.includes(`mcp__${serverName}__*`), false);
  assert.equal(readdirSync(path.join(sessionDir, '.grok', 'skills')).length, 1, 'only the audit skill');
  assert.equal(existsSync(path.join(dirs.project, '.grok')), false, 'the user project is untouched');
  assert.equal(statSync(skillDir).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(skillDir, 'SKILL.md')).mode & 0o777, 0o600);
  assert.equal(removeSessionMcpConfig(run.configPath, { configDir: dirs.configDir }), true);
  assert.equal(existsSync(sessionDir), false);
  assert.deepEqual(readdirSync(path.dirname(sessionDir)).filter(name => name !== '.git'), []);
}));

test('Grok skips the bundled skill when the user already owns a rai-audit skill', () => {
  for (const root of ['.grok', '.agents', '.claude', '.cursor']) withDirs(dirs => {
    mkdirSync(path.join(dirs.home, root, 'skills', 'rai-audit'), { recursive: true });
    writeFileSync(path.join(dirs.home, root, 'skills', 'rai-audit', 'SKILL.md'), '---\nname: rai-audit\n---\n');
    const run = grokLaunch(dirs);
    const sessionDir = run.args[run.args.indexOf('--cwd') + 1];
    assert.equal(existsSync(path.join(sessionDir, '.grok', 'skills')), false, `one /rai-audit only (${root})`);
    assert.equal(existsSync(path.join(sessionDir, '.grok', 'config.toml')), true);
  });
});

test('OpenCode gets /rai-audit from a session command and its own private server', () => withDirs(dirs => {
  const run = openCodeLaunch(dirs, { standalone: true });
  const inline = JSON.parse(run.env.OPENCODE_CONFIG_CONTENT);
  const serverName = Object.keys(inline.mcp).find(name => name.startsWith('rai_studio_session_'));
  assert.deepEqual(run.args, ['--standalone']);
  const command = inline.command['rai-audit'];
  assert.equal(command.description, 'RAI-Studio evidence-led audit of this session');
  assert.ok(command.template.includes(serverName));
  assert.match(command.template, /get_audit_workflow/);
  assert.match(command.template, /audit_session/);
  assert.match(command.template, /\$ARGUMENTS/);
  assert.equal(inline.mcp[serverName].environment.RAI_MCP_PROVIDER, 'opencode');
  assert.equal(existsSync(path.join(dirs.project, '.opencode')), false, 'the user project is untouched');
  removeSessionMcpConfig(run.configPath, { configDir: dirs.configDir });
}));

test('OpenCode starts its default shared service unless the installed binary supports --standalone', () => withDirs(dirs => {
  const plain = openCodeLaunch(dirs);
  assert.deepEqual(plain.args, []);
  assert.ok(JSON.parse(plain.env.OPENCODE_CONFIG_CONTENT).command['rai-audit'], 'the command does not depend on the flag');
  removeSessionMcpConfig(plain.configPath, { configDir: dirs.configDir });
  const table = [
    [['--standalone'], ['--standalone']],
    [['--standalone=true'], ['--standalone=true']],
    [['--no-standalone'], ['--no-standalone']],
    [['--model', 'x'], ['--standalone', '--model', 'x']],
    [['--continue'], ['--standalone', '--continue']],
    [['~/project'], ['--standalone', '~/project']],
    [['--session', 'run'], ['--standalone', '--session', 'run']],
    [['--server', 'http://127.0.0.1:4096'], ['--server', 'http://127.0.0.1:4096']],
    [['--server=http://127.0.0.1:4096'], ['--server=http://127.0.0.1:4096']],
    [['run', 'hello'], ['run', 'hello']],
    [['--log-level', 'debug', 'run', 'hello'], ['--log-level', 'debug', 'run', 'hello']],
    [['serve'], ['serve']],
    [['--', 'tail'], ['--standalone', '--', 'tail']]
  ];
  for (const [args, expected] of table) {
    const run = openCodeLaunch(dirs, { standalone: true, args });
    assert.deepEqual(run.args, expected, JSON.stringify(args));
    removeSessionMcpConfig(run.configPath, { configDir: dirs.configDir });
  }
}));

test('OpenCode keeps a rai-audit command the user already owns', () => {
  const owned = { 'rai-audit': { description: 'mine', template: 'my own audit' } };
  withDirs(dirs => {
    const run = openCodeLaunch(dirs, { inline: { command: { ...owned, other: { template: 'x' } } } });
    const inline = JSON.parse(run.env.OPENCODE_CONFIG_CONTENT);
    assert.deepEqual(inline.command, { ...owned, other: { template: 'x' } });
    removeSessionMcpConfig(run.configPath, { configDir: dirs.configDir });
  });
  const places = [
    { name: 'user commands folder', file: ({ home }) => path.join(home, '.config', 'opencode', 'commands', 'rai-audit.md') },
    { name: 'user command folder', file: ({ home }) => path.join(home, '.config', 'opencode', 'command', 'rai-audit.md') },
    { name: 'XDG_CONFIG_HOME', file: ({ home }) => path.join(home, 'xdg', 'opencode', 'commands', 'rai-audit.md'), env: ({ home }) => ({ XDG_CONFIG_HOME: path.join(home, 'xdg') }) },
    { name: '~/.opencode', file: ({ home }) => path.join(home, '.opencode', 'commands', 'rai-audit.md') },
    { name: 'OPENCODE_CONFIG_DIR', file: ({ home }) => path.join(home, 'custom', 'commands', 'rai-audit.md'), env: ({ home }) => ({ OPENCODE_CONFIG_DIR: path.join(home, 'custom') }) },
    { name: 'project .opencode', file: ({ project }) => path.join(project, '.opencode', 'commands', 'rai-audit.md') },
    { name: 'parent folder .opencode', file: ({ project }) => path.join(project, '.opencode', 'command', 'rai-audit.md'), cwd: ({ project }) => path.join(project, 'sub', 'dir') },
    { name: 'user opencode.json', file: ({ home }) => path.join(home, '.config', 'opencode', 'opencode.json'), text: '{"command":{"rai-audit":{"template":"mine"}}}' },
    { name: 'user opencode.jsonc with comments', file: ({ home }) => path.join(home, '.config', 'opencode', 'opencode.jsonc'), text: '{\n  // mine\n  "command": {\n    "rai-audit": { "template": "mine", },\n  },\n}\n' },
    { name: 'project opencode.json', file: ({ project }) => path.join(project, 'opencode.json'), text: '{"command":{"rai-audit":{"template":"mine"}}}' },
    { name: 'OPENCODE_CONFIG file', file: ({ home }) => path.join(home, 'one.json'), text: '{"command":{"rai-audit":{"template":"mine"}}}', env: ({ home }) => ({ OPENCODE_CONFIG: path.join(home, 'one.json') }) }
  ];
  for (const place of places) withDirs(dirs => {
    const file = place.file(dirs);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, place.text ?? 'my own audit\n');
    const cwd = place.cwd?.(dirs);
    if (cwd) mkdirSync(cwd, { recursive: true });
    const run = buildCliLaunch({ provider: 'opencode', profile: { command: 'opencode', args: [] }, configDir: dirs.configDir, cwd: cwd ?? dirs.project,
      env: { ...ENV, HOME: dirs.home, OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: 'dark' }), ...place.env?.(dirs) } });
    const inline = JSON.parse(run.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(inline.command, undefined, place.name);
    assert.equal(inline.theme, 'dark');
    removeSessionMcpConfig(run.configPath, { configDir: dirs.configDir });
  });
  withDirs(dirs => {
    const run = openCodeLaunch(dirs, { inline: { command: { other: { template: 'x' } } } });
    assert.ok(JSON.parse(run.env.OPENCODE_CONFIG_CONTENT).command['rai-audit'], 'a user command with another name does not suppress the audit command');
    removeSessionMcpConfig(run.configPath, { configDir: dirs.configDir });
  });
  withDirs(dirs => {
    writeFileSync(path.join(dirs.project, 'opencode.json'), '{"command":{"other":{"template":"x"}},"note":"rai-audit"}');
    const run = openCodeLaunch(dirs);
    assert.ok(JSON.parse(run.env.OPENCODE_CONFIG_CONTENT).command['rai-audit'], 'a config that only mentions the name does not own it');
    removeSessionMcpConfig(run.configPath, { configDir: dirs.configDir });
  });
});

test('OpenCode keeps a malformed inline command untouched', () => {
  for (const command of ['native.md', ['x'], null, 7]) withDirs(dirs => {
    const raw = JSON.stringify({ theme: 'dark', command });
    const run = openCodeLaunch(dirs, { inline: JSON.parse(raw) });
    assert.equal(run.configPath, undefined, JSON.stringify(command));
    assert.equal(run.env.OPENCODE_CONFIG_CONTENT, raw);
    assert.match(run.notice, /cannot be safely merged/);
  });
});

test('Codex learns the audit in words because its input rejects an unknown typed command', () => withDirs(dirs => {
  const run = buildCliLaunch({ provider: 'codex', profile: { command: 'codex', args: [] }, configDir: dirs.configDir, cwd: dirs.project, env: { ...ENV, HOME: dirs.home } });
  const guidance = JSON.parse(run.args.find(arg => arg.startsWith('developer_instructions=')).slice('developer_instructions='.length));
  assert.match(guidance, /asks for the RAI audit in words/);
  assert.match(guidance, /`get_audit_workflow` first/);
  assert.match(guidance, /Codex CLI cannot register a command for one session/);
  assert.ok(run.args.includes('mcp_servers.' + /mcp_servers\.(rai_studio_session_[a-f0-9]{32})\./.exec(run.args.join('\n'))[1] + '.env.RAI_MCP_PROVIDER="codex"'));
  removeSessionMcpConfig(run.configPath, { configDir: dirs.configDir });
}));

test('the companion contract and the audit skill agree on how each assistant starts the audit', () => {
  for (const text of [read('prompts/RAI-Assistant.md'), read('skills/rai-audit/SKILL.md')]) {
    for (const name of ['Claude Code', 'Grok Build', 'OpenCode', 'Codex CLI']) assert.ok(text.includes(name), name);
    assert.match(text, /get_audit_workflow/);
    assert.doesNotMatch(text, /only when the bridge launches Claude/);
    assert.doesNotMatch(text, /Do not claim `\/rai-audit` is registered there/);
  }
  assert.match(read('skills/rai-audit/SKILL.md'), /cannot display a tool-result image/);
});

test('snippet hints name the working audit route per assistant', () => {
  assert.equal(skillHint('grok', '/rai-audit').supported, true);
  assert.equal(skillHint('opencode', '/rai-audit').supported, true);
  assert.equal(skillHint('grok', '/other-skill').supported, false);
  assert.equal(skillHint('opencode', '/other-skill').supported, false);
  assert.equal(skillHint('codex', '/rai-audit').supported, false);
  assert.match(skillHint('codex', '/rai-audit').message, /Run the RAI audit/);
  assert.match(skillHint('codex', 'plain text').message, /Run the RAI audit/);
});

test('skill status knows Grok and reports the bundled audit skill for every assistant that registers it', () => {
  const root = temp('rai-assistants-status-');
  try {
    const home = path.join(root, 'home'); const cwd = path.join(root, 'project');
    mkdirSync(home); mkdirSync(cwd);
    for (const provider of ['claude', 'grok', 'opencode']) {
      const status = skillSourceStatus(provider, 'rai-audit', { home, cwd, bridgeDir: REPO_ROOT });
      assert.equal(status.source, 'bundled', provider);
    }
    assert.equal(skillSourceStatus('codex', 'rai-audit', { home, cwd, bridgeDir: REPO_ROOT }).source, null);
    mkdirSync(path.join(cwd, '.grok', 'skills', 'mine'), { recursive: true });
    writeFileSync(path.join(cwd, '.grok', 'skills', 'mine', 'SKILL.md'), '---\nname: mine\n---\n');
    assert.equal(skillSourceStatus('grok', 'mine', { home, cwd }).source, 'project');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function stubs(root) {
  return (name, body) => { const file = path.join(root, name); writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file; };
}

test('openCodeSupportsStandalone asks the installed binary once', () => {
  const root = temp('rai-assistants-flag-');
  try {
    const make = stubs(root);
    const resolve = name => name;
    assert.equal(openCodeSupportsStandalone(make('new', 'echo "  --standalone   Run with a private server"'), { resolve }), true);
    assert.equal(openCodeSupportsStandalone(make('old', 'echo "  --model   Model to use"'), { resolve }), false);
    assert.equal(openCodeSupportsStandalone(make('broken', 'echo "--standalone"; exit 3'), { resolve }), false);
    assert.equal(openCodeSupportsStandalone(path.join(root, 'missing'), { resolve }), false);
    const counted = make('counted', `echo run >> ${JSON.stringify(path.join(root, 'count'))}; echo "--standalone"`);
    assert.equal(openCodeSupportsStandalone(counted, { resolve }), true);
    assert.equal(openCodeSupportsStandalone(counted, { resolve }), true);
    assert.equal(readFileSync(path.join(root, 'count'), 'utf8'), 'run\n', 'cached after the first answer');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('openCodeSupportsStandalone retries a failed probe and follows an upgraded binary', () => {
  const root = temp('rai-assistants-flag-retry-');
  try {
    const make = stubs(root);
    const resolve = name => name;
    const flaky = make('flaky', `if [ -e ${JSON.stringify(path.join(root, 'ready'))} ]; then echo "--standalone"; else exit 9; fi`);
    assert.equal(openCodeSupportsStandalone(flaky, { resolve }), false);
    writeFileSync(path.join(root, 'ready'), '');
    assert.equal(openCodeSupportsStandalone(flaky, { resolve }), true, 'a failure is not remembered');
    const upgraded = make('upgraded', 'echo "--model"');
    assert.equal(openCodeSupportsStandalone(upgraded, { resolve }), false);
    make('upgraded', 'echo "--standalone" # newer build');
    const bumped = statSync(upgraded).mtimeMs / 1000 + 5;
    utimesSync(upgraded, bumped, bumped);
    assert.equal(openCodeSupportsStandalone(upgraded, { resolve }), true, 'the answer follows the file');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the openCodeSupportsStandalone probe never hands the bridge tokens to the binary and finds node next to it', () => {
  const root = temp('rai-assistants-flag-env-');
  const saved = Object.fromEntries(['RAI_BRIDGE_TOKEN', 'RAI_OWNER_TOKEN', 'RAI_RUN_INSPECTOR_URL', 'RAI_BRIDGE_TOKEN_FILE'].map(name => [name, process.env[name]]));
  try {
    const dump = path.join(root, 'dump');
    const probe = stubs(root)('probe', `{ echo "token=$RAI_BRIDGE_TOKEN"; echo "owner=$RAI_OWNER_TOKEN"; echo "inspector=$RAI_RUN_INSPECTOR_URL"; echo "file=$RAI_BRIDGE_TOKEN_FILE"; echo "path=$PATH"; } > ${JSON.stringify(dump)}; echo "--standalone"`);
    for (const name of Object.keys(saved)) process.env[name] = `secret-${name}`;
    assert.equal(openCodeSupportsStandalone(probe, { resolve: name => name }), true);
    const seen = readFileSync(dump, 'utf8');
    assert.match(seen, /^token=$/m);
    assert.match(seen, /^owner=$/m);
    assert.match(seen, /^inspector=$/m);
    assert.match(seen, /^file=$/m);
    assert.equal(seen.includes('secret-'), false);
    const searchPath = /^path=(.*)$/m.exec(seen)[1].split(path.delimiter);
    assert.equal(searchPath[0], root, 'the binary directory leads PATH');
    assert.ok(searchPath.includes(path.dirname(process.execPath)), 'the bundled node directory is on PATH');
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

test('createCliSession and generate-launch pass the standalone decision on to the launch', () => withDirs(dirs => {
  let spawned;
  const session = createCliSession({ provider: 'opencode', profile: { command: 'opencode', args: [] }, configDir: dirs.configDir, cwd: dirs.project, openCodeStandalone: true,
    env: { ...ENV, HOME: dirs.home }, spawn: (command, args, options) => { spawned = { command, args, options }; return {}; } });
  assert.deepEqual(spawned.args, ['--standalone']);
  removeSessionMcpConfig(session.configPath, { configDir: dirs.configDir });

  const bin = temp('rai-assistants-launch-bin-');
  try {
    const opencode = stubs(bin)('opencode', 'echo "  --standalone   Run with a private server"');
    mkdirSync(path.join(dirs.home, '.raistudio'), { recursive: true });
    writeFileSync(path.join(dirs.home, '.raistudio', 'assistant.json'), JSON.stringify({ provider: 'opencode', providers: { opencode: { command: opencode, args: [], authMode: 'subscription' } } }));
    const out = execFileSync(process.execPath, [path.join(REPO_ROOT, 'generate-launch.js')], {
      encoding: 'utf8', env: { ...ENV, HOME: dirs.home, RAI_BRIDGE_CWD: dirs.project }
    });
    assert.match(out, /^exec .*opencode' '--standalone'/m, out);
    assert.match(out, /^export OPENCODE_CONFIG_CONTENT=/m);
    const leftovers = readdirSync(path.join(dirs.home, '.raistudio')).filter(name => /^mcp-/.test(name));
    for (const name of leftovers) rmSync(path.join(dirs.home, '.raistudio', name), { recursive: true, force: true });
  } finally { rmSync(bin, { recursive: true, force: true }); }
}));
