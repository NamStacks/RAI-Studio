/*
 * detect-rosetta.test.ts
 *
 * Copyright (C) 2023 by Posit Software, PBC
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

import { describe, afterEach } from 'mocha';
import { assert } from 'chai';
import { app } from 'electron';

import { detectRosetta } from '../../../src/main/detect-rosetta';

describe('Detect Rosetta', () => {
  afterEach(() => {
    app.commandLine.removeSwitch('automation-agent');
  });

  it('Skips the check entirely in automation mode (no Electron app singleton required)', () => {
    // detectRosetta() reaches into appState(), which is only populated once the
    // real Electron main process has finished initializing. This unit test runs
    // without that singleton, so it must exercise the same automation-agent
    // short-circuit the packaged app uses for E2E/CI runs, rather than falling
    // through into appState() and throwing "application not set".
    app.commandLine.appendSwitch('automation-agent');
    const isRosettaInstalled = detectRosetta();
    assert.isUndefined(isRosettaInstalled);
  });
});
