import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pty from 'node-pty';
const { createCliSession, augmentGuiPath } = await import('../mcp.js');

// A GUI-launched app has no Homebrew or nvm node on PATH. npm-installed CLIs
// such as Codex start with `#!/usr/bin/env node` and exit 127 without it.
for (const provider of ['codex', 'claude']) {
  test(`${provider}: node-script CLI starts when the bridge PATH is GUI-minimal`, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rai-launch-path-'));
    try {
      const cli = path.join(dir, 'fake-cli');
      const out = path.join(dir, 'out.txt');
      writeFileSync(cli, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.RECORD, process.env.PATH);\n', { mode: 0o700 });
      chmodSync(cli, 0o700);
      const env = { PATH: '/usr/bin:/bin', HOME: os.homedir(), RAI_BRIDGE_TOKEN: 'synthetic', RAI_OWNER_TOKEN: 'synthetic',
        RAI_SESSION_HEALTH_URL: 'http://127.0.0.1:19090/health', CLAUDE_CONFIG_DIR: dir, RECORD: out };
      augmentGuiPath(env);
      const { term } = createCliSession({ provider, profile: { command: cli, args: [] }, configDir: dir, cwd: dir, env, spawn: pty.spawn });
      const exitCode = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { term.kill(); reject(new Error('timeout')); }, 5000);
        term.onExit(({ exitCode }) => { clearTimeout(timer); resolve(exitCode); });
      });
      assert.equal(exitCode, 0, 'CLI exit code (127 means env could not find node)');
      const childPath = readFileSync(out, 'utf8').split(path.delimiter);
      assert.deepEqual(childPath.slice(0, 2), ['/usr/bin', '/bin'], 'inherited PATH keeps its order and priority');
      assert.ok(childPath.includes(path.dirname(process.execPath)), 'bundled node directory present');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('augmentGuiPath never reorders or drops inherited entries and adds nothing twice', () => {
  const env = { PATH: `/opt/custom/bin${path.delimiter}/usr/bin${path.delimiter}${path.dirname(process.execPath)}` };
  augmentGuiPath(env);
  const parts = env.PATH.split(path.delimiter);
  assert.deepEqual(parts.slice(0, 3), ['/opt/custom/bin', '/usr/bin', path.dirname(process.execPath)]);
  assert.equal(new Set(parts).size, parts.length, 'no duplicates');
  const absent = {};
  augmentGuiPath(absent);
  assert.ok(path.dirname(process.execPath).length > 0 && absent.PATH.split(path.delimiter).includes(path.dirname(process.execPath)));
});
