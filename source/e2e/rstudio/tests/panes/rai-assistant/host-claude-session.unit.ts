// Deterministic regression for fixtures/host-claude-session.ts (no GUI, no CLI call).
// Run: npx tsx tests/panes/rai-assistant/host-claude-session.unit.ts
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hostClaudeLauncher, hostClaudeSessionRequested, setupHostClaudeSession } from '../../../fixtures/host-claude-session';

let n = 0;
const ok = (msg: string) => { n++; console.log(`ok ${n} ${msg}`); };

// 1. opt-in is strict
for (const [v, want] of [['1', true], ['true', true], ['0', false], ['', false], ['yes', false]] as const) {
  process.env.PW_AI_CLAUDE_HOST_SESSION = v;
  assert.equal(hostClaudeSessionRequested(), want);
}
delete process.env.PW_AI_CLAUDE_HOST_SESSION;
ok('opt-in accepts only 1/true');

// 2. launcher: real HOME, dedicated cwd, user settings excluded, args forwarded, quoting safe
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hcs-'));
const cwd = path.join(tmp, "work dir's");
fs.mkdirSync(cwd);
const fakeCli = path.join(tmp, 'fake-cli');
fs.writeFileSync(fakeCli, '#!/bin/sh\necho "HOME=$HOME"\necho "PWD=$(pwd -P)"\nfor a in "$@"; do echo "ARG=$a"; done\n', { mode: 0o755 });
const text = hostClaudeLauncher({ realHome: '/Users/example', cwd, cli: fakeCli });
const launcher = path.join(tmp, 'launcher');
fs.writeFileSync(launcher, text, { mode: 0o700 });
const out = execFileSync(launcher, ['--mcp-config', '/x y.json'], { env: { HOME: '/sandbox/home', PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
assert.match(out, /^HOME=\/Users\/example$/m);
assert.match(out, new RegExp(`^PWD=${fs.realpathSync(cwd).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
assert.deepEqual(out.split('\n').filter((l) => l.startsWith('ARG=')),
  ['ARG=--setting-sources', 'ARG=project,local', 'ARG=--settings', 'ARG={"theme":"dark"}',
   'ARG=--no-chrome', 'ARG=--mcp-config', 'ARG=/x y.json']);
ok('launcher sets real HOME, enters dedicated cwd, excludes user settings, forwards args verbatim');

// 2b. live-claude-rc2-2 regression: with user settings excluded the CLI had no
//     theme and stopped at its first-run picker; a session-only theme and
//     --no-chrome must precede the bridge args so no interactive onboarding
//     screen can swallow the prompt.
const flags = out.split('\n').filter((l) => l.startsWith('ARG=')).map((l) => l.slice(4));
const settingsJson = JSON.parse(flags[flags.indexOf('--settings') + 1]);
assert.equal(typeof settingsJson.theme, 'string');
assert.ok(settingsJson.theme.length > 0);
assert.ok(flags.indexOf('--no-chrome') >= 0 && flags.indexOf('--no-chrome') < flags.indexOf('--mcp-config'));
ok('launcher pins a session theme and declines Chrome onboarding without host writes');

// 3. setup refuses non-empty / missing workspace before touching anything
process.env.PW_AI_CLAUDE_HOST_CWD = path.join(tmp, 'missing');
assert.throws(() => setupHostClaudeSession(path.join(tmp, 'home1')), /existing absolute directory/);
fs.writeFileSync(path.join(cwd, 'stray'), '');
process.env.PW_AI_CLAUDE_HOST_CWD = cwd;
assert.throws(() => setupHostClaudeSession(path.join(tmp, 'home2')), /must be empty/);
assert.equal(fs.existsSync(path.join(tmp, 'home2')), false);
ok('refuses missing or non-empty workspace without writing');

// 4. never runs with the real HOME as sandbox home
fs.rmSync(path.join(cwd, 'stray'));
assert.throws(() => setupHostClaudeSession(os.homedir()), /must not be the real HOME/);
ok('refuses real HOME as sandbox user-home');

// 5. no credential file is ever referenced by the module
const src = fs.readFileSync(path.join(__dirname, '../../../fixtures/host-claude-session.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
assert.equal(/credentials\.json|copyFileSync|cpSync/.test(src), false);
assert.equal(/writeFileSync\([^)]*claude\.json/.test(src), false);
ok('module never copies credentials or writes ~/.claude.json');

fs.rmSync(tmp, { recursive: true, force: true });
delete process.env.PW_AI_CLAUDE_HOST_CWD;
console.log(`host-claude-session: ${n} checks passed`);
