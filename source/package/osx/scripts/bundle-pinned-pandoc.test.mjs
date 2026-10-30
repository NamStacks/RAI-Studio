import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const helper = fileURLToPath(new URL('../cmake/bundle-pinned-pandoc.cmake', import.meta.url));
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function invoke(binary, sha) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-pinned-pandoc-'));
  const dest = path.join(root, 'RAI-Studio.app/Contents/Resources/app/quarto/bin/tools/aarch64/pandoc');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, 'preserve original');
  const result = spawnSync('cmake', ['-DCMAKE_INSTALL_PREFIX='+root,
    '-DRAI_PACKAGE_PANDOC_BINARY='+binary, '-DRAI_PACKAGE_PANDOC_SHA256='+sha, '-P', helper], { encoding: 'utf8' });
  return { ...result, dest };
}
test('Pandoc pin mismatch fails before execution and preserves original resource', () => {
  const result = invoke(process.execPath, '0'.repeat(64));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA256 mismatch/);
  assert.equal(fs.readFileSync(result.dest, 'utf8'), 'preserve original');
});
test('a matching checksum is not enough without exact Pandoc version and features', () => {
  const result = invoke(process.execPath, hash(process.execPath));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /retain 3.8.3, server and Lua/);
  assert.equal(fs.readFileSync(result.dest, 'utf8'), 'preserve original');
});
test('qualified native Pandoc is copied with its exact identity', {skip: !process.env.RAI_TEST_PANDOC_BINARY}, () => {
  const binary = process.env.RAI_TEST_PANDOC_BINARY;
  const result = invoke(binary, hash(binary));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(hash(result.dest), hash(binary));
  assert.ok(fs.statSync(result.dest).mode & 0o111);
});
test('feature-stripped Pandoc is refused without replacing original', {skip: !process.env.RAI_TEST_PANDOC_NO_SERVER_BINARY}, () => {
  const binary = process.env.RAI_TEST_PANDOC_NO_SERVER_BINARY;
  const result = invoke(binary, hash(binary));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /retain 3.8.3, server and Lua/);
  assert.equal(fs.readFileSync(result.dest, 'utf8'), 'preserve original');
});
