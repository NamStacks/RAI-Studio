'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configurePackageVersion } = require('./configure-package-version.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pkg = { name: 'rstudio', version: '0.1.3', dependencies: { semver: '7.8.5' } };
  const lock = { name: 'rstudio', version: '0.1.3', packages: { '': { name: 'rstudio', version: '0.1.3', dependencies: pkg.dependencies }, 'node_modules/semver': { version: '7.8.5', integrity: 'immutable-fixture' } } };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
  return { dir, pkg, lock };
}
for (const version of ['0.1.59', '0.1.60', '0.1.59-dev+999', '2026.10.0+pro1']) {
  test(`CMake version ${version} replaces only generated root metadata`, t => {
    const { dir, pkg, lock } = fixture(t);
    configurePackageVersion(dir, version);
    const actualPkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
    const actualLock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json')));
    assert.equal(actualPkg.version, version);
    assert.equal(actualLock.version, version);
    assert.equal(actualLock.packages[''].version, version);
    actualPkg.version = pkg.version;
    actualLock.version = lock.version;
    actualLock.packages[''].version = lock.packages[''].version;
    assert.deepEqual(actualPkg, pkg);
    assert.deepEqual(actualLock, lock);
  });
}
test('missing lock root and malformed version fail before writes', t => {
  const { dir } = fixture(t);
  const original = fs.readFileSync(path.join(dir, 'package.json'));
  for (const version of [undefined, '', '0.1.59\n']) {
    assert.throws(() => configurePackageVersion(dir, version), /package version/);
  }
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ version: '0.1.3' }));
  assert.throws(() => configurePackageVersion(dir, '0.1.59'), /package-lock root/);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'package.json')), original);
});
