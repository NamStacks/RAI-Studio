// Ordinary unit fixtures ONLY: Mach-O objects, never runnable product/native QA.
// Keep the real admission helper and its file/lipo checks; do not mock validation.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export function runUnit(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (process.env.RAI_UNIT_RECEIPTS) {
    const hash = text => createHash('sha256').update(text || '').digest('hex');
    appendFileSync(process.env.RAI_UNIT_RECEIPTS, JSON.stringify({ command, args,
      status: result.status, signal: result.signal, error: result.error?.message,
      stdout: result.stdout, stderr: result.stderr,
      stdoutSHA256: hash(result.stdout), stderrSHA256: hash(result.stderr) }) + '\n');
  }
  return result;
}

export const libraries = ['libssl.3.dylib', 'libcrypto.3.dylib', 'libintl.8.dylib', 'libsqlite3.0.dylib', 'libiconv.2.dylib'];
export function prepareUnitFixture() {
  const root = mkdtempSync(join(tmpdir(), 'rai-packaging-unit-'));
  const source = join(root, 'source');
  const install = join(root, 'install');
  const bin = join(install, 'RAI-Studio.app/Contents/Resources/app/bin');
  const frameworks = join(install, 'RAI-Studio.app/Contents/Resources/app/Frameworks');
  const prefixes = { x86_64: join(root, 'pinned-x86_64'), arm64: join(root, 'pinned-arm64') };
  const objects = {};
  writeFileSync(join(root, 'unit.c'), 'int packaging_unit_fixture(void) { return 0; }\n');
  for (const cpu of ['x86_64', 'arm64']) {
    objects[cpu] = join(root, `unit-${cpu}.o`);
    const result = runUnit('/usr/bin/clang', ['-target', `${cpu}-apple-macos13`, '-c', join(root, 'unit.c'), '-o', objects[cpu]]);
    assert.equal(result.status, 0, result.stderr);
    mkdirSync(join(prefixes[cpu], 'lib'), { recursive: true });
    for (const name of libraries) {
      const path = join(prefixes[cpu], 'lib', name);
      copyFileSync(objects[cpu], path);
      appendFileSync(path, `UNIT-${cpu}-${name}`);
    }
  }
  const put = (path, cpu) => {
    mkdirSync(join(path, '..'), { recursive: true });
    copyFileSync(objects[cpu], path); chmodSync(path, 0o755);
  };
  for (const name of ['rsession', 'diagnostics', 'rpostback', 'node/bin/node']) put(join(bin, name), 'x86_64');
  const armSession = join(root, 'arm/rsession');
  const armNode = join(root, 'arm/node');
  for (const name of ['rsession', 'diagnostics', 'rpostback', 'node/bin/node']) put(join(root, 'arm', name), 'arm64');
  mkdirSync(join(source, 'cmake'), { recursive: true });
  mkdirSync(join(source, 'scripts'), { recursive: true });
  copyFileSync(new URL('../cmake/arm64-payload.cmake', import.meta.url), join(source, 'cmake/arm64-payload.cmake'));
  const fixer = join(source, 'scripts/fix-library-paths.sh');
  // Relocation stand-in only; admission still uses real file/lipo and real helper.
  writeFileSync(fixer, '#!/bin/sh\ncase "$3" in\n  "diagnostics rpostback rsession") printf "%s" "-RELOCATED" >> "$1/rsession" ;;\nesac\n');
  chmodSync(fixer, 0o755);
  const values = { CMAKE_CURRENT_SOURCE_DIR: source, CMAKE_OSX_ARCHITECTURES: 'x86_64',
    RAI_PACKAGE_LIBRARY_PREFIX: prefixes.x86_64, RAI_PACKAGE_LIBRARY_ARM64_PREFIX: prefixes.arm64,
    RSESSION_ARM64_PATH: armSession, RAI_NODE_ARM64_DIR: armNode,
    RAI_DIAGNOSTICS_ARM64_PATH: join(root, 'arm/diagnostics'), RAI_RPOSTBACK_ARM64_PATH: join(root, 'arm/rpostback'),
    LICENSEMANAGER_ARM64_PATH: '' };
  function prepare(overrides = {}) {
    let text = readFileSync(process.env.RAI_PREPARE_TEMPLATE || new URL('../cmake/prepare-package.cmake', import.meta.url), 'utf8');
    for (const [key, value] of Object.entries({ ...values, ...overrides })) text = text.replaceAll(`@${key}@`, value);
    const script = join(root, 'prepare.cmake');
    writeFileSync(script, `set(CMAKE_INSTALL_PREFIX "${install}")\n${text}`);
    return runUnit(process.env.CMAKE || 'cmake', ['-P', script]);
  }
  return { root, bin, frameworks, prefixes, armSession, armNode, prepare };
}
