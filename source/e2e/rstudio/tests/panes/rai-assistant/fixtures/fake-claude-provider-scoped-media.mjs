#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const state = arg('--test-state-dir');
if (!state || state.startsWith('--')) throw new Error('isolated state directory required');
mkdirSync(state, { recursive: true });
writeFileSync(`${state}/provider.pid`, String(process.pid));
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', data => appendFileSync(`${state}/draft-input.bin`, data));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const osc = (params, payload) => `\x1b]1337;File=${params}:${payload}\x07`;
process.stdout.write('\x1b[?2004h');
process.stdout.write('RAI_IMAGE_START\r\n');
process.stdout.write(osc('inline=1;size=99999999', png));
process.stdout.write(osc('inline=1;size=30', 'https://malicious.invalid/x.png'));
process.stdout.write(osc(`inline=1;size=${Buffer.from(png, 'base64').length}`, png));
process.stdout.write('\r\nRAI_IMAGE_DONE\r\n');
// Synthetic-only continuous output exercises busy pending drafts without a
// provider call or an R mutation. The test controls this scoped marker file.
setInterval(() => {
  if (existsSync(`${state}/emit-busy`)) process.stdout.write('[fake-provider] working\r');
}, 100);
