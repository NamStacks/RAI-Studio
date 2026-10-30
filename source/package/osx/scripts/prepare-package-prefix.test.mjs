import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { libraries, prepareUnitFixture } from './packaging-unit-fixture.mjs';

// Complete paired unit inputs allow the real pinned-library checks to run.
for (const missingCPU of [null, 'x86_64', 'arm64']) {
  test(`explicit pinned libraries ${missingCPU ? `reject missing ${missingCPU} dependency` : 'copy both CPU sets including transitive dependencies'}`, () => {
    const { bin, frameworks, prefixes, prepare } = prepareUnitFixture();
    const primary = readFileSync(join(bin, 'rsession'));
    if (missingCPU) unlinkSync(join(prefixes[missingCPU], 'lib/libcrypto.3.dylib'));
    const result = prepare();
    if (!missingCPU) {
      assert.equal(result.status, 0, result.stderr);
      for (const cpu of ['x86_64', 'arm64']) {
        for (const name of libraries) {
          const destination = join(frameworks, cpu === 'arm64' ? 'arm64' : '', name);
          assert.deepEqual(readFileSync(destination), readFileSync(join(prefixes[cpu], 'lib', name)));
        }
      }
    } else {
      assert.notEqual(result.status, 0, 'no host fallback for incomplete pinned dependencies');
      assert.match(result.stderr, /Required native file invalid:[\s\S]*libcrypto\.3\.dylib/);
      assert.ok(result.stderr.includes(`pinned-${missingCPU}`), result.stderr);
      assert.doesNotMatch(result.stderr, /include could not find/);
      assert.equal(existsSync(frameworks), false, 'admission must precede copying');
      assert.deepEqual(readFileSync(join(bin, 'rsession')), primary);
    }
  });
}
