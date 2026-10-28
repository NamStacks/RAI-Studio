'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Update only generated build metadata; source/dependency pins remain intact.
function configurePackageVersion(directory, version) {
  if (typeof version !== 'string' || !version || /\s/.test(version)) {
    throw new Error('Missing or malformed CMake package version');
  }
  const packagePath = path.join(directory, 'package.json');
  const lockPath = path.join(directory, 'package-lock.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (!lock.packages || !lock.packages['']) {
    throw new Error('Missing generated package-lock root');
  }
  pkg.version = version;
  lock.version = version;
  lock.packages[''].version = version;
  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}

module.exports = { configurePackageVersion };
if (require.main === module) {
  configurePackageVersion(process.argv[2], process.argv[3]);
}
