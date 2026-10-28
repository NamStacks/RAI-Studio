import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareUnitFixture } from './packaging-unit-fixture.mjs';

// Unit objects exercise copying/admission, NOT native runtime acceptance.
test('universal prepare preserves relocated Intel primary and distinct admitted ARM bytes', () => {
  const fixture = prepareUnitFixture();
  const { bin, armSession, armNode, prepare } = fixture;
  const primary = readFileSync(join(bin, 'rsession'));
  const primaryNode = readFileSync(join(bin, 'node/bin/node'));
  const alternate = readFileSync(armSession);
  const node = readFileSync(join(armNode, 'bin/node'));
  assert.notDeepEqual(primary, alternate);
  const result = prepare();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(join(bin, 'rsession')), Buffer.concat([primary, Buffer.from('-RELOCATED')]));
  assert.deepEqual(readFileSync(join(bin, 'node/bin/node')), primaryNode);
  assert.deepEqual(readFileSync(join(bin, 'rsession-arm64')), alternate);
  assert.deepEqual(readFileSync(join(bin, 'node-arm64/bin/node')), node);
  assert.deepEqual(readFileSync(armSession), alternate, 'producer must remain unchanged');
  assert.deepEqual(readFileSync(join(armNode, 'bin/node')), node);
});

for (const damage of ['missing ARM session', 'wrong ARM CPU', 'ARM primary']) {
  test(`universal prepare rejects ${damage} before copying or relocation`, () => {
    const { bin, armSession, prepare } = prepareUnitFixture();
    const primary = readFileSync(join(bin, 'rsession'));
    const overrides = {};
    if (damage === 'missing ARM session') unlinkSync(armSession);
    if (damage === 'wrong ARM CPU') writeFileSync(armSession, primary);
    if (damage === 'ARM primary') overrides.CMAKE_OSX_ARCHITECTURES = 'arm64';
    const result = prepare(overrides);
    assert.notEqual(result.status, 0, result.stderr);
    const expected = damage === 'ARM primary' ? /requires x86_64 primary/ :
      damage === 'missing ARM session' ? /Required native file invalid:[\s\S]*arm\/rsession/ : /Required arm64 slice missing/;
    assert.match(result.stderr, expected);
    assert.deepEqual(readFileSync(join(bin, 'rsession')), primary);
    assert.equal(existsSync(join(bin, 'rsession-arm64')), false);
  });
}
