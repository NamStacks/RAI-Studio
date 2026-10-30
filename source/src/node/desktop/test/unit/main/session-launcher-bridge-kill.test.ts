/*
 * session-launcher-bridge-kill.test.ts
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
import { ChildProcess, spawn } from 'child_process';
import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { FilePath } from '../../../src/core/file-path';
import { SessionLauncher } from '../../../src/main/session-launcher';
import { ApplicationLaunch } from '../../../src/main/application-launch';
import { Application } from '../../../src/main/application';
import { clearApplicationSingleton, setApplication } from '../../../src/main/app-state';

const kServerScript = `
const net = require('net');
const server = net.createServer((sock) => sock.on('error', () => {}));
server.listen(0, '127.0.0.1', () => console.log('PORT ' + server.address().port));
`;

const kClientScript = `
const net = require('net');
const sock = net.connect(Number(process.argv[2]), '127.0.0.1', () => console.log('CONNECTED'));
sock.on('error', () => {});
setInterval(() => {}, 1000);
`;

async function waitForLine(child: ChildProcess, prefix: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${prefix}`)), 10000);
    let buf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const line = buf.split('\n').find((l) => l.startsWith(prefix));
      if (line !== undefined) {
        clearTimeout(timer);
        resolve(line);
      }
    });
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_e: unknown) {
    return false;
  }
}

async function waitDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (!isAlive(pid)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe('SessionLauncher killRaiBridge', function () {
  this.timeout(30000);

  let tmpRoot: string;
  let savedHome: string | undefined;
  let bridgeDir: string;
  let started: ChildProcess[];

  beforeEach(() => {
    setApplication(new Application());
    started = [];
    savedHome = process.env.HOME;
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-kill-test-'));
    process.env.HOME = tmpRoot;
    fs.mkdirSync(path.join(tmpRoot, '.raistudio'));
    bridgeDir = path.join(tmpRoot, 'rai-chat-bridge');
    fs.mkdirSync(bridgeDir);
    fs.writeFileSync(path.join(bridgeDir, 'server.js'), kServerScript);
  });

  afterEach(() => {
    for (const child of started) {
      child.kill('SIGKILL');
    }
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    clearApplicationSingleton();
  });

  function launcherWithPort(sessionPort: number): SessionLauncher {
    const launcher = new SessionLauncher(new FilePath(), new FilePath(), new FilePath(), new ApplicationLaunch(), null);
    (launcher as unknown as { raiSessionPort: number }).raiSessionPort = sessionPort;
    return launcher;
  }

  async function startBridge(cwd = bridgeDir): Promise<{ child: ChildProcess; port: number }> {
    const child = spawn('node', ['server.js'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    started.push(child);
    const line = await waitForLine(child, 'PORT ');
    return { child, port: parseInt(line.substring(5), 10) };
  }

  it('kills only the verified listener, not a client connected to the bridge port', async () => {
    const { child: bridge, port } = await startBridge();
    const clientScript = path.join(tmpRoot, 'client.js');
    fs.writeFileSync(clientScript, kClientScript);
    const client = spawn('node', [clientScript, String(port)], { stdio: ['ignore', 'pipe', 'ignore'] });
    started.push(client);
    await waitForLine(client, 'CONNECTED');

    const stateFile = path.join(tmpRoot, '.raistudio', 'bridge-41000.port');
    fs.writeFileSync(stateFile, `${port}\n${bridge.pid}`);

    launcherWithPort(41000).killRaiBridge();

    assert.isTrue(await waitDead(bridge.pid as number), 'bridge should be killed');
    assert.isTrue(isAlive(client.pid as number), 'client of the bridge must survive');
    assert.isFalse(fs.existsSync(stateFile), 'state file should be removed');
  });

  it('does not kill a listener whose pid differs from the recorded pid', async () => {
    const { child: bridge, port } = await startBridge();
    const stateFile = path.join(tmpRoot, '.raistudio', 'bridge-41001.port');
    fs.writeFileSync(stateFile, `${port}\n${(bridge.pid as number) + 100000}`);

    launcherWithPort(41001).killRaiBridge();

    await new Promise((r) => setTimeout(r, 500));
    assert.isTrue(isAlive(bridge.pid as number), 'unrecorded listener must survive');
  });

  it('does not kill a listener that is not the bridge process', async () => {
    const otherScript = path.join(tmpRoot, 'other.js');
    fs.writeFileSync(otherScript, kServerScript);
    const other = spawn('node', [otherScript], { stdio: ['ignore', 'pipe', 'ignore'] });
    started.push(other);
    const port = parseInt((await waitForLine(other, 'PORT ')).substring(5), 10);
    const stateFile = path.join(tmpRoot, '.raistudio', 'bridge-41002.port');
    fs.writeFileSync(stateFile, `${port}\n${other.pid}`);

    launcherWithPort(41002).killRaiBridge();

    await new Promise((r) => setTimeout(r, 500));
    assert.isTrue(isAlive(other.pid as number), 'a non-bridge process must survive');
  });

  it('does not kill a node server.js whose working directory is not rai-chat-bridge', async () => {
    const otherDir = path.join(tmpRoot, 'other-dir');
    fs.mkdirSync(otherDir);
    fs.writeFileSync(path.join(otherDir, 'server.js'), kServerScript);
    const { child: other, port } = await startBridge(otherDir);
    const stateFile = path.join(tmpRoot, '.raistudio', 'bridge-41004.port');
    fs.writeFileSync(stateFile, `${port}\n${other.pid}`);

    launcherWithPort(41004).killRaiBridge();

    await new Promise((r) => setTimeout(r, 500));
    assert.isTrue(isAlive(other.pid as number), 'a server.js outside rai-chat-bridge must survive');
  });

  it('kills the bridge when the app emits will-quit', async () => {
    const { child: bridge, port } = await startBridge();
    const launcher = new SessionLauncher(new FilePath(), new FilePath(), new FilePath(), new ApplicationLaunch(), null);
    const before = app.listeners('will-quit');
    await launcher.buildLaunchContext();
    const added = app.listeners('will-quit').filter((l) => !before.includes(l));
    assert.lengthOf(added, 1, 'buildLaunchContext must register one will-quit listener');

    const sessionPort = (launcher as unknown as { raiSessionPort: number }).raiSessionPort;
    const stateFile = path.join(tmpRoot, '.raistudio', `bridge-${sessionPort}.port`);
    fs.writeFileSync(stateFile, `${port}\n${bridge.pid}`);

    (added[0] as () => void)();
    app.removeListener('will-quit', added[0] as () => void);

    assert.isTrue(await waitDead(bridge.pid as number), 'bridge should be killed on will-quit');
    assert.isFalse(fs.existsSync(stateFile), 'state file should be removed');
  });

  it('runs the kill once only', async () => {
    const { child: bridge, port } = await startBridge();
    const stateFile = path.join(tmpRoot, '.raistudio', 'bridge-41003.port');
    fs.writeFileSync(stateFile, `${port}\n${bridge.pid}`);
    const launcher = launcherWithPort(41003);

    launcher.killRaiBridge();
    assert.isTrue(await waitDead(bridge.pid as number));

    const second = await startBridge();
    fs.writeFileSync(stateFile, `${second.port}\n${second.child.pid}`);
    launcher.killRaiBridge();
    await new Promise((r) => setTimeout(r, 500));
    assert.isTrue(isAlive(second.child.pid as number), 'a second call must do nothing');
    assert.isTrue(fs.existsSync(stateFile), 'a second call must keep the state file');
  });
});
