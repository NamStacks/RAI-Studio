/*
 * system.ts
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

import { v4 as uuidv4 } from 'uuid';
import crc from 'crc';
import fs from 'fs';
import { createServer } from 'net';

import { FilePath } from './file-path';

export function generateUuid(includeDashes = true): string {
  let uuid = uuidv4();
  if (!includeDashes) {
    uuid = uuid.replace(/-/g, '');
  }
  return uuid;
}

export function generateShortenedUuid(): string {
  return crc.crc32(generateUuid(false)).toString(16);
}

/**
 * Ports Chromium refuses to load, failing with ERR_UNSAFE_PORT (-312).
 *
 * This matters here because the renderer loads the session over
 * http://127.0.0.1:<port>. Binding one of these produces a permanently blank
 * window: the page never loads, so there is no IDE and no in-app error to
 * report -- it looks exactly like a hung launch. Verified in the wild as
 * "Failed to load http://127.0.0.1:10080: Error: ERR_UNSAFE_PORT (-312)".
 *
 * Mirrors Chromium's kRestrictedPorts (net/base/port_util.cc). Only 10080 falls
 * inside the range generateRandomPort() draws from today; the rest are listed
 * so the guard stays correct if that range is ever widened.
 */
const CHROMIUM_RESTRICTED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697,
  10080,
]);

/**
 * Whether Chromium would refuse to load http://127.0.0.1:<port>.
 *
 * @param port The port to test.
 * @returns true if the port is on Chromium's restricted list.
 */
export function isRestrictedPort(port: number): boolean {
  return CHROMIUM_RESTRICTED_PORTS.has(port);
}

export function generateRandomPort(): number {
  // Create a random-ish port number to avoid collisions between different
  // instances of rdesktop-launched rsessions; not a cryptographically
  // secure technique so don't copy/paste for such purposes.
  //
  // Restricted ports are redrawn rather than returned: a bindable port is not
  // necessarily a loadable one, and isPortFree() below only proves bindable.
  // The bound keeps this total; with a handful of excluded values out of 40000
  // it is never reached in practice, and the +1 fallback is itself safe because
  // no two restricted ports are adjacent in this range.
  for (let attempt = 0; attempt < 8; attempt++) {
    const base = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    const port = (base % 40000) + 8080;
    if (!isRestrictedPort(port)) {
      return port;
    }
  }

  return 8080;
}

/**
 * Check whether a TCP port can currently be bound on the loopback interface.
 *
 * @param port The port to test.
 * @returns A promise resolving to true if the port is free, false otherwise.
 */
async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();

    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });

    server.listen(port, '127.0.0.1');
  });
}

/**
 * Find a TCP port that is currently free on the loopback interface.
 *
 * Picks random candidates with generateRandomPort() and verifies each is
 * bindable before returning it, so two RStudio instances launched at the same
 * time are very unlikely to hand the same port to their rsession backends. A
 * small time-of-check/time-of-use window remains -- the port could be claimed
 * between this probe and rsession's own bind -- but that is far narrower than
 * trusting an unverified random number, which is the dominant collision source
 * when many sessions start concurrently (e.g. parallel E2E workers).
 *
 * Falls back to an unverified random port if no candidate is found free within
 * maxAttempts, so callers always receive a usable port.
 *
 * @param maxAttempts The maximum number of candidate ports to probe.
 * @returns A promise resolving to a port number.
 */
export async function findFreePort(maxAttempts = 20): Promise<number> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = generateRandomPort();
    if (await isPortFree(candidate)) {
      return candidate;
    }
  }

  return generateRandomPort();
}

export function localPeer(port: number): string {
  // local peer used for named-pipe communication on Windows
  return `\\\\.\\pipe\\${port.toString()}-rsession`;
}

export function isCentOS(): boolean {
  if (process.platform === 'linux') {
    const redhatRelease = new FilePath('/etc/redhat-release');
    if (redhatRelease.existsSync()) {
      try {
        const contents = fs.readFileSync(redhatRelease.getAbsolutePath(), 'utf-8');
        return contents.includes('CentOS') || contents.includes('Red Hat Enterprise Linux');
      } catch (_error: unknown) {
        return false;
      }
    }
  }
  return false;
}

export function fixupExecutablePath(exePath: FilePath): FilePath {
  if (process.platform !== 'win32') {
    return exePath; // do nothing on posix
  }

  if (exePath.getExtension().length === 0) {
    return exePath.getParent().completePath(exePath.getFilename() + '.exe');
  } else {
    return exePath;
  }
}
