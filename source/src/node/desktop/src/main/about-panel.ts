/*
 * about-panel.ts
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

import { app, AboutPanelOptionsOptions } from 'electron';

function creditsText(version: string): string {
  return [
    'RAI-Studio is an independent fork of the open source RStudio project, copyright Posit Software, PBC and contributors.',
    'It is licensed under the GNU Affero General Public License version 3 and comes with no warranty.',
    `Source code: https://github.com/NamStacks/RAI-Studio (tag v${version}-beta, folder source/)`,
  ].join('\n\n');
}

export function aboutPanelOptions(version: string): AboutPanelOptionsOptions {
  return {
    applicationName: 'RAI-Studio',
    applicationVersion: version + ' Beta',
    credits: creditsText(version),
  };
}

export function configureAboutPanel(): void {
  app.setAboutPanelOptions(aboutPanelOptions(app.getVersion()));
}
