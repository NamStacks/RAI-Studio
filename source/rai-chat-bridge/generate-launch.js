#!/usr/bin/env node
// Prints a POSIX sh script that cds into the project directory and execs the configured provider CLI with this session's MCP wiring, the same launch the embedded pty uses.
//
// Requires RAI_BRIDGE_TOKEN and RAI_SESSION_HEALTH_URL in the environment
// (set by the C++ session backend, same as for the embedded bridge).
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCliLaunch, shellQuote } from './mcp.js';
import { CONFIG_DIR, loadConfig } from './config.js';
import { openCodeSupportsStandalone } from './provider-status.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = loadConfig({ persistMigration: !process.env.RAI_SESSION_HEALTH_URL });
const profile = config.providers[config.provider];
if (!profile) {
  console.error(`unknown provider: ${config.provider}`);
  process.exit(1);
}

try {
  // Terminal.app supplies the user's login environment. Never serialize the
  // inherited rsession env: it can contain owner tokens and other secrets.
  // Only OpenCode's builder-added inline overlay is needed by the outer CLI;
  // its connector uses a private token-file reference, not a bearer.
  const cwd = process.env.RAI_BRIDGE_CWD || os.homedir();
  const { command, args, env: childEnv } = buildCliLaunch({
    provider: config.provider,
    profile,
    configDir: CONFIG_DIR,
    bridgeDir: __dirname,
    cwd,
    env: process.env,
    openCodeStandalone: config.provider === 'opencode' && openCodeSupportsStandalone(profile.command)
  });

  const overlayKeys = config.provider === 'opencode' ? ['OPENCODE_CONFIG_CONTENT'] : [];
  const exports = overlayKeys
    .filter(key => childEnv[key] !== undefined && childEnv[key] !== process.env[key])
    .map(key => `export ${key}=${shellQuote(childEnv[key])}`);
  const lines = [
    '#!/bin/sh',
    `cd ${shellQuote(cwd)} || exit 1`,
    ...exports,
    `exec ${[command, ...args].map(shellQuote).join(' ')}`
  ];
  process.stdout.write(lines.join('\n') + '\n');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
