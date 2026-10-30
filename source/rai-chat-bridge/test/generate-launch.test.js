import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEST_HEALTH_URL = 'http://127.0.0.1:19090/rsession-local/rai-assistant/health';
const TEST_TOKEN = 'e2e-test-token-do-not-leak';

// config.js's CONFIG_DIR is `path.join(os.homedir(), '.raistudio')` with no
// dedicated env override -- but Node's os.homedir() honors $HOME on POSIX, so
// pointing HOME at a throwaway temp dir keeps loadConfig()/writeConfig() off
// the real ~/.raistudio directory without touching config.js itself.
function runGenerateLaunch({ cwd, home }) {
  return spawnSync(process.execPath, ['generate-launch.js'], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      RAI_BRIDGE_TOKEN: TEST_TOKEN,
      RAI_SESSION_HEALTH_URL: TEST_HEALTH_URL,
      RAI_BRIDGE_CWD: cwd
    },
    encoding: 'utf8'
  });
}

test('generate-launch.js emits a #!/bin/sh script with one cd and one exec line', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'rai-launch-home-'));
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'rai-launch-cwd-'));

  const result = runGenerateLaunch({ cwd, home });

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split('\n').filter(line => line.length > 0);

  assert.equal(lines[0], '#!/bin/sh');
  assert.deepEqual(lines.filter(line => line.startsWith('cd ')), [`cd '${cwd}' || exit 1`]);
  assert.equal(lines.filter(line => line.startsWith('exec ')).length, 1);
});

test('generate-launch.js does not export inherited env vars for Claude (the RAI_OWNER_TOKEN leak fix)', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'rai-launch-home-'));
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'rai-launch-cwd-'));

  const result = runGenerateLaunch({ cwd, home });

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split('\n');

  // An earlier version did `export KEY=value` for every var in buildCliLaunch's
  // returned env, which leaked RAI_OWNER_TOKEN into this persistent script.
  // Claude needs only argv; the real terminal supplies its login environment.
  assert.equal(lines.some(line => line.startsWith('export')), false);
  assert.equal(result.stdout.includes(TEST_TOKEN), false);
});
