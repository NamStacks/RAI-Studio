#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';

// Stands in for grok 1.0.70: records how the bridge launched it, then idles.
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const state = arg('--test-state-dir');
if (!state || state.startsWith('--')) throw new Error('isolated state directory required');
mkdirSync(state, { recursive: true });
writeFileSync(`${state}/provider.pid`, String(process.pid));
const argv = process.argv.slice(2);
// Real grok changes into --cwd; the pty itself starts in the project folder.
if (arg('--cwd')) process.chdir(arg('--cwd'));
let projectLink = null;
let mcp = '';
try { projectLink = readlinkSync(`${process.cwd()}/project`); } catch { /* absent */ }
try { mcp = readFileSync(`${process.cwd()}/.grok/config.toml`, 'utf8'); } catch { /* absent */ }
appendFileSync(`${state}/grok-launches.jsonl`, JSON.stringify({
  argv, cwd: process.cwd(), projectLink,
  mcpEntry: /\[mcp_servers\.rai_studio_session_[a-f0-9]+\]/.test(mcp),
  tokenInEnv: Boolean(process.env.RAI_BRIDGE_TOKEN || process.env.RAI_OWNER_TOKEN)
}) + '\n');
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', data => appendFileSync(`${state}/draft-input.bin`, data));
process.stdout.write('\x1b[?2004hFake Grok ready\r\n');
