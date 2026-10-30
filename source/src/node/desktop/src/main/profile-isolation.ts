/*
 * profile-isolation.ts
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

import { app } from 'electron';
import path from 'path';

/**
 * Name of the sibling userData directory Electron is redirected to. Keeps this
 * build's Electron profile (cookies, local storage, GPU cache, session storage,
 * etc.) from colliding with a standard RStudio Desktop install's userData
 * directory on the same machine.
 */
export const kRaiStudioUserDataDirName = 'RAI-Studio';

/**
 * Redirects Electron's userData directory to a sibling of the default
 * userData directory, named kRaiStudioUserDataDirName. Must be called before
 * app.whenReady() and before any other code reads app.getPath('userData'),
 * since Electron subsystems cache the userData path as soon as they touch it.
 *
 * Nothing is redirected when the default directory already carries that name.
 *
 * This only affects Electron's own profile storage; it has no effect on the
 * C++ backend's XDG data/config directories.
 */
export function isolateUserDataProfile(): void {
  const defaultUserDataPath = app.getPath('userData');
  if (path.basename(defaultUserDataPath) === kRaiStudioUserDataDirName) {
    return;
  }
  const isolatedUserDataPath = path.join(path.dirname(defaultUserDataPath), kRaiStudioUserDataDirName);
  app.setPath('userData', isolatedUserDataPath);
}
