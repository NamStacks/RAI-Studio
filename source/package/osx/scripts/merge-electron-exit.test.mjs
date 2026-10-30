import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUnit } from './packaging-unit-fixture.mjs';
const template = readFileSync(process.env.RAI_MERGE_TEMPLATE || new URL('../cmake/merge-electron.cmake', import.meta.url), 'utf8');
// Child stubs are ordinary unit control-flow fixtures, NOT Electron/native QA.
for (const [step, mergeExit] of [['success without npm provisioning', 0], ['merge failure', 7], ['missing ARM input', 0]]) {
  test(`merge-electron ${step}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'rai-merge-unit-'));
    const intel = join(root, 'intel.app');
    const arm = join(root, 'arm.app');
    mkdirSync(intel);
    if (step !== 'missing ARM input') mkdirSync(arm);
    const npm = join(root, 'npm');
    const node = join(root, 'node');
    const npmCalled = join(root, 'npm-called');
    const nodeArgs = join(root, 'node-args');
    writeFileSync(npm, `#!/bin/sh\nprintf called > "${npmCalled}"\nexit 3\n`);
    writeFileSync(node, `#!/bin/sh\nprintf '%s\\n' "$@" > "${nodeArgs}"\nexit ${mergeExit}\n`);
    chmodSync(npm, 0o755); chmodSync(node, 0o755);
    let configured = template;
    for (const [key, value] of Object.entries({ NPM: npm, NODEJS: node,
      CMAKE_CURRENT_SOURCE_DIR: root, ELECTRON_SOURCE_DIR: root,
      RAI_ELECTRON_X86_64_APP: intel, RAI_ELECTRON_ARM64_APP: arm }))
      configured = configured.replaceAll(`@${key}@`, value);
    const script = join(root, 'merge.cmake');
    writeFileSync(script, `set(CMAKE_INSTALL_PREFIX "${root}/install")\n${configured}`);
    const result = runUnit(process.env.CMAKE || 'cmake', ['-P', script], {
      env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
    });
    assert.equal(existsSync(npmCalled), false, 'installation must not provision dependencies');
    if (step === 'missing ARM input') {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Universal Electron input missing or invalid/);
      assert.ok(result.stderr.includes(arm), result.stderr);
      assert.equal(existsSync(nodeArgs), false, 'merge child must not run before admission');
    } else {
      assert.deepEqual(readFileSync(nodeArgs, 'utf8').trimEnd().split('\n'), [
        join(root, 'scripts/merge-electron.mjs'), intel, arm, join(root, 'install/RAI-Studio.app'),
      ]);
      if (mergeExit === 0) assert.equal(result.status, 0, result.stderr);
      else {
        assert.notEqual(result.status, 0, 'child failure silently accepted');
        assert.match(result.stderr, /Universal Electron merge failed: 7/);
      }
    }
  });
}
