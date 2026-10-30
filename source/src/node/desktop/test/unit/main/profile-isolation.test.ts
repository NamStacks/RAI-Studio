/*
 * profile-isolation.test.ts
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
import { app } from 'electron';
import path from 'path';

import { isolateUserDataProfile, kRaiStudioUserDataDirName } from '../../../src/main/profile-isolation';

describe('ProfileIsolation', () => {
  let originalUserDataPath: string;

  beforeEach(() => {
    originalUserDataPath = app.getPath('userData');
  });

  afterEach(() => {
    app.setPath('userData', originalUserDataPath);
  });

  it('redirects userData to a sibling RAI-Studio directory', () => {
    const before = path.join(path.dirname(originalUserDataPath), 'RStudio');
    app.setPath('userData', before);
    isolateUserDataProfile();
    const after = app.getPath('userData');

    assert.notEqual(after, before);
    assert.equal(path.basename(after), kRaiStudioUserDataDirName);
    assert.equal(path.dirname(after), path.dirname(before));
  });

  it('leaves userData untouched when it already is the RAI-Studio directory', () => {
    const before = path.join(path.dirname(originalUserDataPath), kRaiStudioUserDataDirName);
    app.setPath('userData', before);
    const originalSetPath = app.setPath.bind(app);
    let setPathCalls = 0;
    app.setPath = ((name: string, value: string) => {
      setPathCalls++;
      originalSetPath(name as 'userData', value);
    }) as typeof app.setPath;
    try {
      isolateUserDataProfile();
    } finally {
      app.setPath = originalSetPath as typeof app.setPath;
    }

    assert.equal(app.getPath('userData'), before);
    assert.equal(setPathCalls, 0);
  });

  it('is idempotent when called more than once', () => {
    isolateUserDataProfile();
    const first = app.getPath('userData');
    isolateUserDataProfile();
    const second = app.getPath('userData');

    assert.equal(first, second);
  });
});
