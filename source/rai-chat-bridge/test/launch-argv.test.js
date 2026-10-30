import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pty from 'node-pty';
import { spawnSync } from 'node:child_process';
const { createCliSession, buildCliLaunch } = await import(process.env.S9B_MCP_MODULE || '../mcp.js');
const { tools: nativeMcpTools } = await import('../rai-native-mcp.js');
const env = { PATH: process.env.PATH, HOME: os.homedir(), RAI_BRIDGE_TOKEN: 's9b-synthetic-secret', RAI_OWNER_TOKEN: 's9b-synthetic-secret', RAI_SESSION_HEALTH_URL: 'http://127.0.0.1:19090/health' };
const cases = {
  claude: ['--model', 'X', '--resume', 'session X', '--continue', '--dangerously-skip-permissions', '--permission-mode', 'acceptEdits', '--disallowedTools', 'Bash', '--plugin-dir', '/native/plugin with spaces', '--extension', 'literal $(touch NEVER); *', '--no-chrome', '--strict-mcp-config', '--append-system-prompt', '--', '--append-system-prompt', 'user guidance', '--settings', './missing-settings.json', '--disallowedTools', 'mcp__rai__*', '--safe-mode', '--system-prompt-snapshot', 'on', '--', 'positional prompt', '--mcp-config', 'literal'],
  codex: ['--no-alt-screen', '--model=X', 'resume', 'session X', '--last', '--dangerously-bypass-approvals-and-sandbox', '--sandbox', 'workspace-write', '--ask-for-approval', 'never', '-c', 'model_reasoning_effort="high"', '--config', 'mcp_servers.native.command="native"', '--extension', 'literal $HOME', '--add-dir', '/tmp', '-c=model_reasoning_effort="high"', '--remote', 'http://example.invalid', '--', 'positional prompt', '-c=mcp_servers.rai.enabled=false'],
  opencode: ['--model', 'X', '--resume', 'session X', '--continue', '--agent', 'native', '--permission', 'native', '--extension=x', '--server', 'http://example.invalid', '--', 'positional prompt'],
  grok: ['--model', 'X', '--resume', 'session X', '--continue', '--sandbox', 'native', '--extension=x'],
};
for (const [provider, args] of Object.entries(cases)) {
  test(`${provider}: session API executes exact native argv through real PTY`, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 's9b-pty-'));
    let term;
    try {
      const recorder = path.join(dir, 'recorder');
      const output = path.join(dir, 'exec.json');
      writeFileSync(recorder, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.S9B_RECORD, JSON.stringify({argv:process.argv.slice(2),env:process.env,tty:process.stdout.isTTY}));\n`, { mode: 0o700 });
      ({ term } = createCliSession({ provider, profile: { command: recorder, args }, configDir: dir, cwd: dir,
        env: { ...env, CLAUDE_CONFIG_DIR: dir, S9B_RECORD: output }, spawn: pty.spawn }));
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { term.kill(); reject(new Error('recorder timeout')); }, 5000);
        term.onExit(({ exitCode }) => { clearTimeout(timer); exitCode === 0 ? resolve() : reject(new Error(`recorder exit ${exitCode}`)); });
      });
      const actual = JSON.parse(readFileSync(output));
      assert.equal(actual.tty, true, 'real PTY');
      const boundary = provider === 'claude' ? args.length - 4 : provider === 'codex' ? args.length - 3 : args.length;
      const injectedCount = actual.argv.length - args.length;
      assert.deepEqual([...actual.argv.slice(0, boundary), ...actual.argv.slice(boundary + injectedCount)], args, 'native argv exact and ordered');
      const injected = actual.argv.slice(boundary, boundary + injectedCount);
      if (boundary < args.length) assert.equal(actual.argv[boundary + injectedCount], '--', 'injection before terminator');
      if (provider === 'claude') {
        for (const flag of ['--append-system-prompt-file', '--allowedTools', '--mcp-config', '--plugin-dir']) assert.ok(injected.includes(flag), `RAI injection ${flag}`);
        assert.ok(!injected.includes('--strict-mcp-config'));
        assert.ok(!injected.includes('--no-chrome'));
        assert.equal(actual.argv.filter(x => x === '--plugin-dir').length, 2, 'repeatable native and RAI plugins');
        assert.ok(readFileSync(injected[injected.indexOf('--mcp-config') + 1], 'utf8').includes('rai'));
      }
      if (provider === 'codex') {
        assert.ok(injected.some(x => x.startsWith('developer_instructions=')), 'RAI guidance');
        assert.ok(injected.some(x => /^mcp_servers\.rai_studio_session_[a-f0-9]+\.command=/.test(x)), 'RAI injection command');
        assert.ok(injected.some(x => /^mcp_servers\.rai_studio_session_[a-f0-9]+\.args=\[\]$/.test(x)), 'RAI injection args');
      }
      if (provider === 'opencode') {
        const inline = JSON.parse(actual.env.OPENCODE_CONFIG_CONTENT);
        assert.ok(Object.values(inline.mcp).find(server => server.environment?.RAI_BRIDGE_TOKEN).enabled, 'RAI env injection');
        assert.match(Object.values(inline.mcp).find(server => server.environment?.RAI_BRIDGE_TOKEN).environment.RAI_BRIDGE_TOKEN, /^\{file:.+\.token\}$/);
        assert.ok(!JSON.stringify(inline).includes(env.RAI_BRIDGE_TOKEN), 'inline config contains no bearer');
      }
      if (provider === 'grok') {
        assert.ok(!injected.some(arg => arg === '--add-dir' || arg.startsWith('--add-dir=')), 'grok rejects --add-dir ("a session works only in its cwd")');
        assert.ok(injected.includes('--trust'), 'session root trusted without the folder prompt');
        const sessionDir = injected[injected.indexOf('--cwd') + 1];
        const root = path.dirname(sessionDir);
        assert.equal(path.dirname(root), path.join(dir, 'grok-sessions'), 'sessions live under one project root');
        assert.ok(existsSync(path.join(root, '.git', 'HEAD')), 'project root is a repository marker');
        assert.equal(realpathSync(path.join(sessionDir, 'project')), realpathSync(dir), 'project reachable through the session link');
        const written = readFileSync(path.join(sessionDir, '.grok', 'config.toml'), 'utf8');
        assert.ok(!written.includes(env.RAI_BRIDGE_TOKEN), 'session MCP file has no bearer');
        assert.ok(!readFileSync(path.join(sessionDir, 'AGENTS.md'), 'utf8').includes(env.RAI_BRIDGE_TOKEN), 'session notes have no bearer');
        assert.match(written, /rai_studio_session_[a-f0-9]+/);
      }
      assert.ok(!JSON.stringify(actual).includes(env.RAI_BRIDGE_TOKEN), 'no secret in exec argv/env');
      if (process.env.S9B_EVIDENCE_DIR) writeFileSync(path.join(process.env.S9B_EVIDENCE_DIR, `${provider}.json`), JSON.stringify(actual, null, 2));
    } finally { try { term?.kill(); } catch {} rmSync(dir, { recursive: true, force: true }); }
  });
}
const replacements = ['developer_instructions="x"', 'mcp_servers={}', 'mcp_servers.rai={}', 'mcp_servers.rai.enabled=false', ' mcp_servers.rai.args =[]'];
const spellings = value => [['-c', value], [`-c=${value}`], [`-c${value}`], ['--config', value], [`--config=${value}`]];
const refusals = [
  ...['--mcp-config', '--append-system-prompt-file'].flatMap(flag => [['claude', [flag, 'user']], ['claude', [`${flag}=user`]]]),
  ...replacements.flatMap(value => spellings(value).map(args => ['codex', args]))
];
for (const [provider, args] of refusals) {
  test(`${provider} refuses ${JSON.stringify(args)} before publication or spawn`, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 's9b-refuse-'));
    try {
      let spawned = false;
      assert.throws(() => createCliSession({ provider, profile: { command: process.execPath, args }, configDir: dir, env,
        spawn() { spawned = true; throw new Error('must not spawn'); } }), /RAI connector conflict:/);
      assert.equal(spawned, false);
      assert.deepEqual(readdirSync(dir), []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
const passthrough = [
  ...[
    ['--settings', './missing-settings.json'], ['--settings', '{"permissions":{"deny":["mcp__rai__*"]}}'],
    ['--settings={"disallowedTools":["mcp__rai__*"]}'], ['--disallowedTools', 'mcp__rai__*'], ['--disallowed-tools=mcp__rai__*'],
    ['--safe-mode'], ['--system-prompt-snapshot', 'on'], ['--no-chrome', '--strict-mcp-config', '--no-chrome', '--strict-mcp-config'],
    ['--append-system-prompt', 'user guidance'], ['--plugin-dir', '/one', '--plugin-dir', '/two'],
    ...['--allowedTools', '--allowed-tools'].flatMap(flag => [[flag, 'user'], [`${flag}=user`]])
  ].map(args => ['claude', args]),
  ...[['--remote', 'http://example.invalid'], ['--remote=http://example.invalid']].map(args => ['codex', args]),
  ...['mcp_servers."rai".enabled=false', '"developer_instructions"="x"', 'mcp_servers.other.command="x"', 'mcp_servers.rail.enabled=false', 'model="x"', 'model_reasoning_effort="high"'].flatMap(value => spellings(value).map(args => ['codex', args])),
  ['opencode', ['--server', 'http://example.invalid', '--', 'prompt']], ['grok', ['--server', 'native', '--', 'prompt']]
];
for (const [provider, args] of passthrough) {
  test(`${provider} preserves ${JSON.stringify(args)}`, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 's9b-pass-'));
    try {
      const launch = buildCliLaunch({ provider, profile: { command: process.execPath, args }, configDir: dir, env });
      assert.deepEqual(launch.args.slice(0, args.length), args);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

// Expected boundaries are explicit fixtures, independent of the production scan.
const boundaries = [
  ['claude', ['--append-system-prompt', '--mcp-config'], 2],
  ['claude', ['--append-system-prompt', '--', '--', '--mcp-config'], 2],
  ...['--resume-session-at', '--resume-drops-turn'].flatMap(flag => [
    ['claude', [flag, '--mcp-config'], 2],
    ['claude', [flag, '--', '--', '--mcp-config'], 2]
  ]),
  ['claude', ['--model', '--mcp-config'], 2],
  ['claude', ['--system-prompt-file', '--mcp-config'], 2],
  ['claude', ['--model', '--allowedTools'], 2],
  ['claude', ['--model', '--allowed-tools'], 2],
  ['claude', ['--', '--allowedTools'], 0],
  ['claude', ['--', '--allowed-tools'], 0],
  ['claude', ['--tools', '--mcp-config'], 2],
  ['claude', ['--tools', '--', '--', '--mcp-config'], 2],
  ['claude', ['--tools', 'Read', 'Edit', '--', '--mcp-config'], 3],
  ['claude', ['--tools=Read', 'Edit', '--', '--mcp-config'], 2],
  ['claude', ['--debug', '--', '--mcp-config'], 1],
  ['claude', ['--debug', 'filter', '--', '--mcp-config'], 2],
  ['claude', ['-n--', '--', '--mcp-config'], 1],
  ['claude', ['--plugin-dir', 'one', 'two', '--', '--mcp-config'], 3],
  ['codex', ['-c', 'model="--"', '--', '-cmcp_servers={}'], 2],
  ['codex', ['-m', '--', '-cmcp_servers={}'], 1],
  ['codex', ['--model=--', '--', '-cmcp_servers={}'], 1],
  ['codex', ['-m--config=mcp_servers={}', '--', '-cmcp_servers={}'], 1],
  ['codex', ['--profile=--config=mcp_servers={}', '--', '-cmcp_servers={}'], 1],
  ['codex', ['--image=--', '--', '-cmcp_servers={}'], 1],
  ['claude', ['-cn--', '--', '--mcp-config'], 1],
  ['claude', ['--resume=--', '--', '--mcp-config'], 1],
  ['codex', ['-i', 'one', 'two', '--', '-cmcp_servers={}'], 3],
  ['codex', ['--unknown', '--', '-cmcp_servers={}'], 1],
  ['claude', ['--unknown', '--', '--mcp-config'], 1],
  ['claude', ['-xn', '--', '--mcp-config'], 1]
];
for (const [provider, args, boundary] of boundaries) {
  test(`${provider} arity boundary ${JSON.stringify(args)}`, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 's9b-boundary-'));
    try {
      const launch = buildCliLaunch({ provider, profile: { command: process.execPath, args }, configDir: dir, env });
      const count = launch.args.length - args.length;
      assert.deepEqual(launch.args.slice(0, boundary), args.slice(0, boundary));
      assert.deepEqual(launch.args.slice(boundary + count), args.slice(boundary));
      assert.ok(launch.args.slice(boundary, boundary + count).includes(provider === 'claude' ? '--mcp-config' : '-c'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
for (const [provider, args] of [
  ['claude', ['--append-system-prompt', '--', '--mcp-config', 'user.json']],
  ...['--resume-session-at', '--resume-drops-turn'].map(flag =>
    ['claude', [flag, '--', '--mcp-config', 'user.json']]),
  ['claude', ['--tools', '--', '--mcp-config', 'user.json']],
  ['claude', ['--tools', 'Read', 'Edit', '--mcp-config', 'user.json']],
  ['claude', ['--debug', '--mcp-config', 'user.json']],
  ['claude', ['--unknown', '--mcp-config', 'user.json']],
  ['claude', ['-xn', '--mcp-config', 'user.json']],
  ['codex', ['-m', 'native', '-c', 'mcp_servers={}']],
  ['codex', ['--unknown', '-cmcp_servers={}']]
]) {
  test(`${provider} refuses active flag after values ${JSON.stringify(args)}`, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 's9b-active-'));
    try {
      assert.throws(() => buildCliLaunch({ provider, profile: { command: process.execPath, args }, configDir: dir, env }), /RAI connector conflict:/);
      assert.deepEqual(readdirSync(dir), []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

// Only top-level option declarations, never examples or wrapped descriptions.
function helpOptions(help) {
  const section = help.split('\nOptions:\n')[1]?.split('\nCommands:\n')[0] || '';
  return [...section.matchAll(/^ {2,6}(-[^\n]*?)(?= {2,}|\n)/gm)].flatMap(([, declaration]) => {
    const value = declaration.match(/[<[][^>\]]+[>\]](?:\.\.\.)?/);
    const arity = !value ? 'boolean' : value[0].includes('...') ? 'variadic' : value[0][0] === '[' ? 'optional' : 'required';
    return [...declaration.slice(0, value?.index).matchAll(/--?[\w-]+/g)].map(([flag]) => [flag, arity]);
  });
}
for (const provider of ['claude', 'codex']) {
  test(`${provider} installed help value options are covered by committed arity table`, async t => {
    const result = spawnSync(provider, ['--help'], { encoding: 'utf8', timeout: 10000 });
    if (result.error?.code === 'ENOENT') { t.skip(`${provider} not installed; arity regeneration unavailable`); return; }
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const options = helpOptions(result.stdout);
    assert.ok(options.length > 20, 'help declarations parsed');
    const { CLI_OPTION_ARITY } = await import(process.env.S9B_MCP_MODULE || '../mcp.js');
    for (const [flag, arity] of options) assert.ok(CLI_OPTION_ARITY[provider][arity].includes(flag), `${flag} ${arity} missing from table`);
    t.diagnostic(`${provider}: regenerated ${options.length} option aliases from installed --help`);
  });
}
// Inspect declarations rather than a frozen hidden-flag list. An installed binary
// with an unfamiliar layout fails explicitly instead of silently losing coverage.
test('claude installed root bundle value options include hidden declarations', async t => {
  const version = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (version.error?.code === 'ENOENT') { t.skip('claude not installed; bundle unavailable'); return; }
  assert.equal(version.status, 0, version.stderr || String(version.error));
  const executable = process.env.PATH.split(path.delimiter).map(dir => path.join(dir, 'claude'))
    .find(file => { try { return realpathSync(file); } catch { return false; } });
  const bundle = readFileSync(realpathSync(executable)).toString('latin1');
  // Minifiers rename the locals between releases; anchor on the stable strings.
  const start = bundle.search(/let [\w$]+=r\.name\("claude"\)/);
  const end = bundle.indexOf('("run_main_options_built")', start);
  assert.ok(start >= 0 && end > start, 'installed Claude root declaration block located');
  const declarations = [...bundle.slice(start, end).matchAll(/(?:\.option\(|new [\w$]+\()"([^"]+)"/g)]
    .map(([, declaration]) => declaration);
  assert.ok(declarations.length > 100, 'complete root declarations parsed, including hidden options');
  const { CLI_OPTION_ARITY } = await import(process.env.S9B_MCP_MODULE || '../mcp.js');
  let values = 0;
  for (const declaration of declarations) {
    const value = declaration.match(/[<[][^>\]]+[>\]]/);
    if (!value) continue;
    const arity = value[0].includes('...') ? 'variadic' : value[0][0] === '[' ? 'optional' : 'required';
    for (const [flag] of declaration.slice(0, value.index).matchAll(/--?[\w-]+/g)) {
      assert.ok(CLI_OPTION_ARITY.claude[arity].includes(flag), `${flag} ${arity} missing from table`);
      values++;
    }
  }
  t.diagnostic(`claude: ${declarations.length} root declarations, ${values} value aliases (hidden included)`);
});
test('codex installed parser completion value options include hidden declarations', async t => {
  const result = spawnSync('codex', ['completion', 'bash'], { encoding: 'utf8', timeout: 10000 });
  if (result.error?.code === 'ENOENT') { t.skip('codex not installed; parser completions unavailable'); return; }
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const root = result.stdout.match(/^        codex\)\n([\s\S]*?)^        codex__/m)?.[1];
  assert.ok(root, 'root parser completion block located');
  // Each explicit previous-word arm consumes a value; the wildcard does not.
  const flags = [...root.matchAll(/^                (--?[\w-]+)\)/gm)].map(([, flag]) => flag);
  assert.ok(flags.length >= 18, 'value arms parsed');
  const { CLI_OPTION_ARITY } = await import(process.env.S9B_MCP_MODULE || '../mcp.js');
  for (const flag of flags) assert.ok(
    CLI_OPTION_ARITY.codex.required.includes(flag) || CLI_OPTION_ARITY.codex.variadic.includes(flag),
    `${flag} value option missing from table`);
  t.diagnostic(`codex: ${flags.length} root value aliases (hidden included)`);
});

for (const [shape, args] of [
  ['camel', ['--allowedTools', 'Read']],
  ['hyphen', ['--allowed-tools', 'Edit']],
  ['repeat', ['--allowedTools', 'Read', '--allowed-tools', 'Edit']],
  ['equals', ['--allowed-tools=Read', '--allowedTools=Edit']],
  ['empty-equals', ['--allowedTools=', '--allowed-tools=Edit']],
  ['native-policy', ['--permission-mode', 'default', '--allowedTools', 'Read', '--disallowedTools', 'Bash']],
  ['native-server', ['--allowed-tools', 'mcp__rai__*']]
]) {
  test(`Claude native allowlist ${shape} remains additive to exact session tools`, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rai-allowlist-'));
    try {
      const launch = buildCliLaunch({provider: 'claude', profile: {command: process.execPath, args}, configDir: dir, env});
      assert.deepEqual(launch.args.slice(0, args.length), args, 'native tokens preserved exactly');
      const injected = launch.args.slice(args.length);
      const config = JSON.parse(readFileSync(launch.configPath, 'utf8'));
      const names = Object.keys(config.mcpServers);
      assert.equal(names.length, 1);
      assert.match(names[0], /^rai_studio_session_[a-f0-9]{32}$/);
      const at = injected.indexOf('--allowedTools');
      assert.ok(at >= 0);
      const end = injected.findIndex((value, index) => index > at && value.startsWith('--'));
      assert.deepEqual(injected.slice(at + 1, end < 0 ? undefined : end),
        nativeMcpTools.map(tool => `mcp__${names[0]}__${tool.name}`), 'RAI grants only exact owned tools');
      assert.ok(!JSON.stringify({args: launch.args, env: launch.env}).includes(env.RAI_BRIDGE_TOKEN));
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });
}
// Real terminator controls above use documented arity: invoking a CLI after
// a real terminator would enter its session path, so those are not native probes.
for (const flag of ['--allowedTools', '--allowed-tools']) {
  test(`Claude missing native allowlist value ${flag} keeps native error`, t => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rai-allowlist-missing-'));
    try {
      const args = ['--model', 'native-model', flag];
      const launch = buildCliLaunch({provider: 'claude', profile: {command: 'claude', args}, configDir: dir, env});
      assert.deepEqual(launch.args.slice(0, 2), args.slice(0, 2));
      assert.equal(launch.args.at(-1), flag, 'generated options cannot become the missing native value');
      const result = spawnSync('claude', launch.args, {
        cwd: dir, env: {...launch.env, CLAUDE_CONFIG_DIR: dir}, encoding: 'utf8', timeout: 10000
      });
      if (result.error?.code === 'ENOENT') { t.skip('claude not installed; native parser unavailable'); return; }
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /option '--allowedTools, --allowed-tools <tools\.\.\.>' argument missing/);
      assert.ok(!result.stderr.includes(env.RAI_BRIDGE_TOKEN));
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });
}
for (const [provider, args, error] of [
  ...['--resume-session-at', '--resume-drops-turn'].flatMap(flag => [
    ['claude', [flag, '--mcp-config', '--help'], false],
    ['claude', [flag, '--', '--s9b-invalid'], true]
  ]),
  ['claude', ['--append-system-prompt', '--', '--s9b-invalid'], true],
  ['claude', ['--append-system-prompt', '--mcp-config', '--help'], false],
  ['claude', ['--tools', '--', '--s9b-invalid'], true],
  ['claude', ['--plugin-dir', '--s9b-invalid', '--help'], false],
  ['claude', ['--debug', '--s9b-invalid'], true],
  ['codex', ['-m', '--', '--help'], true],
  ['codex', ['-c', '--', '--help'], true],
  ['codex', ['-m', '--config', '--help'], true],
  ['codex', ['-i', 'one', 'two', '--help'], false],
  ['codex', ['--model=--', '--help'], false]
]) {
  test(`${provider} native parse-only control ${JSON.stringify(args)}`, t => {
    const result = spawnSync(provider, args, { encoding: 'utf8', timeout: 10000 });
    if (result.error?.code === 'ENOENT') { t.skip(`${provider} not installed; native parser unavailable`); return; }
    assert.equal(result.status, error ? (provider === 'codex' ? 2 : 1) : 0, result.stdout + result.stderr);
    if (error) assert.match(result.stderr, provider === 'claude' ? /unknown option '--s9b-invalid'/ : /a value is required/);
    else assert.match(result.stdout, /Usage:/);
  });
}

// Cover each committed value option, including aliases, without deriving expected
// boundaries from the scanner under test.
const { CLI_OPTION_ARITY } = await import(process.env.S9B_MCP_MODULE || '../mcp.js');
for (const [provider, arities] of Object.entries(CLI_OPTION_ARITY)) {
  for (const kind of ['required', 'optional', 'variadic']) {
    for (const flag of arities[kind]) {
      if (provider === 'claude' && ['--mcp-config', '--append-system-prompt-file'].includes(flag)) continue;
      const literal = provider === 'claude' && kind !== 'optional' ? '--mcp-config' : 'literal --mcp-config -cmcp_servers={}';
      test(`${provider} ${kind} literal value for ${flag}`, () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 's9b-value-'));
        try {
          const args = [flag, literal, '--', 'literal tail'];
          const launch = buildCliLaunch({ provider, profile: { command: process.execPath, args }, configDir: dir, env });
          assert.deepEqual(launch.args.slice(0, 2), args.slice(0, 2));
          assert.deepEqual(launch.args.slice(-2), args.slice(-2));
        } finally { rmSync(dir, { recursive: true, force: true }); }
      });
    }
  }
}

for (const [provider, flag, expectedUsage] of [
  ['claude', '--plugin-dir', /Usage: claude mcp /],
  ['claude', '--tools', /Usage: claude \[options\]/],
  ['codex', '-i', /Usage: codex \[OPTIONS\]/]
]) {
  test(`${provider} native scalar versus variadic control ${flag}`, t => {
    const result = spawnSync(provider, [flag, 'one', 'mcp', '--help'], { encoding: 'utf8', timeout: 10000 });
    if (result.error?.code === 'ENOENT') { t.skip(`${provider} not installed; native parser unavailable`); return; }
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, expectedUsage);
  });
}
