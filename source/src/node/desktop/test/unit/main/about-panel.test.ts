/*
 * about-panel.test.ts
 *
 * Copyright (C) 2026 by Posit Software, PBC
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

import { aboutPanelOptions, configureAboutPanel } from '../../../src/main/about-panel';

describe('AboutPanel', () => {
  it('labels the version as Beta', () => {
    const options = aboutPanelOptions('0.1.62');
    assert.equal(options.applicationName, 'RAI-Studio');
    assert.equal(options.applicationVersion, '0.1.62 Beta');
  });

  it('says that the project is an independent fork of RStudio', () => {
    const credits = aboutPanelOptions('0.1.62').credits ?? '';
    assert.include(credits, 'RAI-Studio is an independent fork of the open source RStudio project');
  });

  it('names the license and the source location', () => {
    const credits = aboutPanelOptions('0.1.62').credits ?? '';
    assert.include(credits, 'GNU Affero General Public License');
    assert.include(credits, 'https://github.com/NamStacks/RAI-Studio');
    assert.include(credits, 'v0.1.62-beta');
  });

  it('can be applied without throwing', () => {
    assert.doesNotThrow(() => configureAboutPanel());
    assert.isString(app.getVersion());
  });
});
