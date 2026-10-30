import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test as baseTest, expect } from '@fixtures/rstudio.fixture';
import { executeCommand, getChatState } from '@utils/commands';
import { ConsolePaneActions } from '@actions/console_pane.actions';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

const CODE = "{ cat('RAI_ENDPOINT_PORT_RECOVERED=42\\n') }";

// Keep this worker-scoped rsession separate from earlier/later specs. A
// previous Assistant success leaves the stable callback port legitimately
// bound until its worker exits. This distinct worker fixture pool forces a
// fresh app without terminating any other process or weakening assertions.
const test = baseTest.extend<{}, { collisionWorkerIsolation: boolean }>({
  collisionWorkerIsolation: [async ({}, use) => { await use(true); }, { scope: 'worker', auto: true }],
});

function currentRaiSessionPort(): number {
  const appPath = process.env.PW_RSTUDIO_PATH ?? '';
  if (!appPath.endsWith('/RAI-Studio.app/Contents/MacOS/RAI-Studio'))
    throw new Error('Packaged RAI-Studio path required');
  const appRoot = appPath.slice(0, -'/Contents/MacOS/RAI-Studio'.length);
  const lines = execFileSync('/bin/ps', ['-ww', '-axo', 'command='], { encoding: 'utf8' }).split('\n');
  const sessions = lines.filter((line: string) => line.includes(`${appRoot}/Contents/Resources/app/bin/rsession`) &&
    /\/rsession(?:-arm64)?\s/.test(line) && line.includes('--rai-session-port '));
  if (sessions.length !== 1)
    throw new Error(`Expected exactly one staged rsession; got ${sessions.length}`);
  const match = sessions[0].match(/(?:^|\s)--rai-session-port\s+(\d+)(?:\s|$)/);
  const port = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Staged rsession endpoint port unavailable');
  return port;
}

async function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));
}

// The endpoint is lazy and stays bound after a successful recovery in this
// worker-scoped rsession. Exercise terminal collision while unbound first;
// after its failed bind, recovery can still acquire the same port.
test('persistent endpoint bind collision fails closed after bounded retries', async ({ rstudioPage: page }) => {
  test.setTimeout(60000);
  const fixture = await setupScriptedRaiTest('endpoint-bind-persistent', 'fake-claude-provider-matrix.mjs', {},
    { proposals: [{ language: 'R', target: 'console', code: CODE }] });
  const blocker = net.createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(currentRaiSessionPort(), '127.0.0.1', resolve);
    });
    await page.evaluate((file) => (window as any).rstudio.project.open(file), fixture.projectFile);
    await page.waitForFunction(expected => (window as any).rstudio?.ready === true &&
      (window as any).rstudio?.project?.path?.() === expected, fixture.projectPath, { timeout: 60000 });
    const frame = page.locator("iframe[title='RAI Assistant']");
    if (!await frame.isVisible()) await executeCommand(page, 'activateChat');
    await expect(frame).toBeVisible({ timeout: 15000 });
    await expect.poll(() => getChatState(page), { timeout: 8000, intervals: [250] }).toBe('starting');
    await expect.poll(() => getChatState(page), { timeout: 25000, intervals: [500] }).toBe('not-found');
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);
    expect(fs.existsSync(path.join(fixture.stateDir, 'results.json'))).toBe(false);
  } finally {
    await closeServer(blocker);
    await teardownScriptedRaiTest(page, fixture.stateDir);
  }
});

test('stable authenticated session endpoint waits for a brief local bind collision, then reconnects without bypass', async ({ rstudioPage: page }) => {
  test.setTimeout(150000);
  const fixture = await setupScriptedRaiTest('endpoint-bind-collision', 'fake-claude-provider-matrix.mjs', {},
    { proposals: [{ language: 'R', target: 'console', code: CODE }] });
  const port = currentRaiSessionPort();
  const blocker = net.createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(port, '127.0.0.1', resolve);
    });
    await page.evaluate((file) => (window as any).rstudio.project.open(file), fixture.projectFile);
    await page.waitForFunction(expected => (window as any).rstudio?.ready === true &&
      (window as any).rstudio?.project?.path?.() === expected, fixture.projectPath, { timeout: 60000 });
    const frame = page.locator("iframe[title='RAI Assistant']");
    if (!await frame.isVisible()) await executeCommand(page, 'activateChat');
    await expect(frame).toBeVisible({ timeout: 15000 });
    // The listener cannot authenticate to our synthetic occupant, nor claim ready.
    await expect.poll(() => getChatState(page), { timeout: 8000, intervals: [250] }).toBe('starting');
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);
    await closeServer(blocker);
    await expect.poll(() => getChatState(page), { timeout: 30000, intervals: [500] }).toBe('ready');
    await expect(page.locator('.rai-approval-card')).toHaveCount(0);
    await expect(new ConsolePaneActions(page).consolePane.consoleOutput)
      .toContainText('RAI_ENDPOINT_PORT_RECOVERED=42', { timeout: 30000 });
    await expect.poll(() => {
      const result = path.join(fixture.stateDir, 'results.json');
      return fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, 'utf8')) : [];
    }, { timeout: 15000 }).toMatchObject([
      { proposal: { code: CODE }, result: { status: 'ok', stdout: expect.stringContaining('RAI_ENDPOINT_PORT_RECOVERED=42') } },
    ]);
  } finally {
    await closeServer(blocker);
    await teardownScriptedRaiTest(page, fixture.stateDir);
  }
});

