import { spawn as spawnProcess } from 'node:child_process';
import { commandExists } from './mcp.js';

const CAFFEINATE_MAX_SECONDS = 12 * 60 * 60;

// Hold display and system-idle assertions for the live CLI. `-u` refreshes
// user activity (screensaver/idle detection); `-s` also prevents AC system
// sleep. This remains separate from the CLI so a toggle never restarts it.
export function createCaffeinateGuard({ pid, enabled = true, env = process.env, spawn = spawnProcess } = {}) {
  if (!enabled || process.platform !== 'darwin' || !Number.isInteger(pid) || pid <= 0 || !commandExists('caffeinate')) return null;
  // The guard never contacts the native R endpoint, so it must not inherit
  // either capability token. Keep this consistent with every other spawned
  // helper/CLI process in the bridge.
  const childEnv = { ...env };
  delete childEnv.RAI_BRIDGE_TOKEN;
  delete childEnv.RAI_OWNER_TOKEN;
  const child = spawn('caffeinate', ['-d', '-i', '-s', '-u', '-t', String(CAFFEINATE_MAX_SECONDS), '-w', String(pid)], {
    stdio: 'ignore',
    windowsHide: true,
    env: childEnv
  });
  child?.on?.('error', () => {});
  return child;
}
