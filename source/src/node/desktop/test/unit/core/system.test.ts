/*
 * system.test.ts
 *
 * Copyright (C) 2022 by Posit Software, PBC
 *
 * Unless you have received this program directly from Posit Software pursuant
 * to the terms of a commercial license agreement with Posit Software, then
 * this program is licensed to you under the terms of version 3 of the
 * GNU Affero General Public License. This program is distributed WITHOUT
 * ANY EXPRESS OR IMPLIED WARRANTY, INCLUDING THOSE OF NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE. Please refer to the
 * AGPL (http://www.gnu.org/licenses/agpl-3.0.txt) for more details.
 *
 */

import { describe } from 'mocha';
import { assert } from 'chai';

import { createServer } from 'net';

import { FilePath } from '../../../src/core/file-path';
import {
  findFreePort,
  fixupExecutablePath,
  generateRandomPort,
  generateShortenedUuid,
  generateUuid,
  isCentOS,
  isRestrictedPort,
} from '../../../src/core/system';

describe('System', () => {
  it('generateUuid returns uuid string with dashes', () => {
    const uuid = generateUuid();
    assert.isTrue(uuid.indexOf('-') >= 0);
  });
  it('generateUuid returns uuid string without dashes', () => {
    const uuid = generateUuid(false);
    assert.isTrue(uuid.length > 0);
    assert.isTrue(uuid.indexOf('-') < 0);
  });
  it('generateShortenedUuid returns character string', () => {
    const crc32 = generateShortenedUuid();
    assert.isNotEmpty(crc32);
    assert.isTrue(crc32.indexOf('-') < 0);
  });
  it('generateRandomPort returns random positive number', () => {
    const port1 = generateRandomPort();
    const port2 = generateRandomPort();
    assert.notEqual(port1, port2);
    assert.isAbove(port1, 0);
    assert.isAbove(port2, 0);
  });
  // Regression: the renderer loads the session over http://127.0.0.1:<port>,
  // so a port Chromium refuses (ERR_UNSAFE_PORT) produces a permanently blank
  // window with no in-app error. 10080 is the one restricted port inside the
  // 8080-48079 range these draw from, and it was reachable: observed in the
  // wild as "Failed to load http://127.0.0.1:10080: ERR_UNSAFE_PORT (-312)".
  // Bindable is not the same as loadable, and isPortFree only proves bindable.
  it('isRestrictedPort knows the Chromium-restricted ports in the allocation range', () => {
    assert.isTrue(isRestrictedPort(10080));
    assert.isFalse(isRestrictedPort(10079));
    assert.isFalse(isRestrictedPort(10081));
    assert.isFalse(isRestrictedPort(8080));
    assert.isFalse(isRestrictedPort(48079));
  });
  it('generateRandomPort never returns a Chromium-restricted port', () => {
    // Every draw is in range and loadable. The loop is large enough that a
    // reintroduced 1-in-40000 hole would show up across repeated CI runs.
    for (let i = 0; i < 20000; i++) {
      const port = generateRandomPort();
      assert.isAtLeast(port, 8080);
      assert.isAtMost(port, 48079);
      assert.isFalse(isRestrictedPort(port), `drew restricted port ${port}`);
    }
  });
  it('findFreePort never returns a Chromium-restricted port', async () => {
    for (let i = 0; i < 25; i++) {
      assert.isFalse(isRestrictedPort(await findFreePort()));
    }
  });
  it('findFreePort returns a port that is actually bindable', async () => {
    const port = await findFreePort();
    assert.isAbove(port, 0);

    // the port findFreePort handed back should itself be free to bind
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it('isCentOS returns reasonable result on this platform', () => {
    // Can't fully test this without reimplementing it here; but we can make sure it
    // is in the ballpark!
    const centOS = isCentOS();
    if (centOS) {
      assert.isTrue(process.platform === 'linux');
    }
    if (process.platform !== 'linux') {
      assert.isFalse(centOS);
    }
  });
  it('fixupExecutablePath adds missing exe extension on Windows', () => {
    const path = new FilePath('hello');
    const fixedPath = fixupExecutablePath(path);
    const exeExtension = '.exe';
    if (process.platform === 'win32') {
      assert.isTrue(fixedPath.getAbsolutePath().endsWith(exeExtension));
    } else {
      assert.isFalse(fixedPath.getAbsolutePath().endsWith(exeExtension));
    }
  });
  it('fixupExecutablePath does not add exe extension if already there', () => {
    const path = new FilePath('helloworld.exe');
    const fixedPath = fixupExecutablePath(path);
    assert.equal(path.getAbsolutePath(), fixedPath.getAbsolutePath());
  });
});
