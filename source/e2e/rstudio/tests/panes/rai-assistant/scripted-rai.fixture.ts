import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { RSTUDIO_PATH } from '@fixtures/desktop.fixture';

type ScriptedRaiTest = {
  projectFile: string;
  // ApplicationAutomation.project.path() reports the active .Rproj path in
  // the session's home-relative form, rather than the host absolute path.
  projectPath: string;
  stateDir: string;
};

// Every scripted suite drives the RAI Assistant bridge, which the session
// resolves from the app bundle first (SessionRaiAssistant.cpp
// resolveBridgeDir: <app resources>/rai-chat-bridge/server.js) and otherwise
// from a macOS developer-checkout path. A bundle packaged without the bridge
// therefore fails every one of these tests only by timeout -- ~1 minute each,
// with nothing in the log naming the cause. Check the bundle under test up
// front and fail with the actual reason instead.
//
// This does not relax anything: when the bridge is present the check is a
// no-op and each test still asserts its full behaviour; when it is absent
// the test fails, now immediately and truthfully. RAI_BRIDGE_DIR still lets a
// developer point a non-bundled build at an explicit checkout, exactly as the
// product honours it.
export function bundledBridgeProblem(executable: string = RSTUDIO_PATH): string | undefined {
  const override = process.env.RAI_BRIDGE_DIR;
  if (override)
    return fs.existsSync(path.join(override, 'server.js'))
      ? undefined
      : `RAI_BRIDGE_DIR=${override} has no server.js`;

  // macOS: <X>.app/Contents/MacOS/<exe> -> <X>.app/Contents/Resources/app
  const contents = path.dirname(path.dirname(executable));
  if (path.basename(contents) !== 'Contents')
    return undefined; // not a macOS bundle layout; the product resolves differently
  const serverJs = path.join(contents, 'Resources', 'app', 'rai-chat-bridge', 'server.js');
  return fs.existsSync(serverJs)
    ? undefined
    : `app under test has no bundled RAI bridge: ${serverJs} is missing ` +
      '(package it with RAI_BRIDGE_SOURCE_DIR pointing at a rai-chat-bridge checkout)';
}

function assertBridgeBundled(): void {
  const problem = bundledBridgeProblem();
  if (problem)
    throw new Error(problem);
}

export function sandboxHome(): string {
  const sandbox = process.env.PW_SANDBOX;
  if (!sandbox)
    throw new Error('PW_SANDBOX is not set');
  return path.join(sandbox, 'user-home');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopPid(pid: number, signal: NodeJS.Signals): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid))
    return;
  try {
    process.kill(pid, signal);
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (!isAlive(pid) || Date.now() >= deadline)
        resolve();
      else
        setTimeout(poll, 50);
    };
    poll();
  });
  if (isAlive(pid) && signal !== 'SIGKILL') {
    process.kill(pid, 'SIGKILL');
    await stopPid(pid, 'SIGKILL');
  }
  if (isAlive(pid))
    throw new Error(`Process ${pid} survived ${signal}`);
}

async function stopSandboxBridges(): Promise<void> {
  const raiDir = path.join(sandboxHome(), '.raistudio');
  if (!fs.existsSync(raiDir))
    return;
  for (const name of fs.readdirSync(raiDir).filter((entry) => /^bridge-\d+\.port$/.test(entry))) {
    const stateFile = path.join(raiDir, name);
    const [, rawPid] = fs.readFileSync(stateFile, 'utf8').trim().split(/\s+/);
    await stopPid(Number(rawPid), 'SIGKILL');
    fs.rmSync(stateFile, { force: true });
  }
}

export async function setupScriptedRaiTest(
  id: string,
  providerFixture: string,
  files: Record<string, string>,
  scenario?: unknown,
  autoApproveReadOnly = false,
  provider: 'claude' | 'codex' | 'grok' = 'claude',
): Promise<ScriptedRaiTest> {
  assertBridgeBundled();
  await stopSandboxBridges();

  const projectName = `rai-${id}`;
  const projectDir = path.join(sandboxHome(), 'rai-tests', id, 'workspace');
  const configDir = path.join(sandboxHome(), 'rai-tests', id, 'config');
  const stateDir = path.join(sandboxHome(), 'rai-tests', id, 'processes');
  const projectFile = path.join(projectDir, `${projectName}.Rproj`);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  for (const name of ['scenario.json', 'provider-ready', 'proceed', 'proposal-ready', 'approval-completed', 'result.json'])
    fs.rmSync(path.join(stateDir, name), { force: true });
  fs.writeFileSync(projectFile, 'Version: 1.0\n');
  for (const [name, contents] of Object.entries(files))
    fs.writeFileSync(path.join(projectDir, name), contents);
  if (scenario !== undefined)
    fs.writeFileSync(path.join(stateDir, 'scenario.json'), JSON.stringify(scenario));

  const providerPath = path.resolve(process.cwd(), 'tests/panes/rai-assistant/fixtures', providerFixture);
  const config = {
    provider,
    model: '',
    // Seeded off so a scripted suite exercises the approval card by default and
    // its expectations do not silently depend on how isSafeReadOnlyR happens to
    // classify that suite's proposal. The shipped product default is ON (see
    // DEFAULT_CONFIG in rai-chat-bridge/config.js); the suite that covers the
    // on state turns it on for itself, which is also what proves an explicit
    // choice in this file survives bridge startup.
    // See rai-auto-approve-readonly-scripted.test.ts.
    autoApproveReadOnly,
    providers: {
      [provider]: {
        command: 'node',
        args: [providerPath, '--test-state-dir', stateDir],
        modelFlag: '--model',
      },
    },
  };
  const configText = JSON.stringify(config, null, 2);
  fs.writeFileSync(path.join(configDir, 'assistant.json'), configText);
  const raiDir = path.join(sandboxHome(), '.raistudio');
  fs.mkdirSync(raiDir, { recursive: true });
  fs.writeFileSync(path.join(raiDir, 'assistant.json'), configText);

  return {
    projectFile,
    projectPath: `~/rai-tests/${id}/workspace/${projectName}.Rproj`,
    stateDir,
  };
}

export async function teardownScriptedRaiTest(page: Page, stateDir?: string): Promise<void> {
  const frame = page.locator("iframe[title='RAI Assistant']");
  if (await frame.count())
    await frame.evaluate((element: HTMLIFrameElement) => { element.src = 'about:blank'; }).catch(() => {});

  if (stateDir && fs.existsSync(stateDir)) {
    for (const name of ['provider.pid', 'mcp.pid']) {
      const pidFile = path.join(stateDir, name);
      if (fs.existsSync(pidFile))
        await stopPid(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM');
    }
  }
  await stopSandboxBridges();
  fs.rmSync(path.join(sandboxHome(), '.raistudio', 'assistant.json'), { force: true });
}
