import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { executeCommand, getChatState } from '@utils/commands';
import { workerUserHome } from '@fixtures/desktop.fixture';

/**
 * Start a fresh authenticated bridge for a live RAI test.
 *
 * Scripted RAI specs deliberately blank the iframe and kill their fake bridge
 * during teardown. Desktop sessions are shared between adjacent specs, so an
 * activateChat command alone can retain a stale "ready" state while the iframe
 * remains about:blank. The product's hard Reset Assistant action is the
 * supported recovery path: it clears the cached URL and starts a new bridge.
 */
export async function openFreshLiveRaiAssistant(page: Page): Promise<void> {
  await executeCommand(page, 'activateChat');
  await expect(page.locator("iframe[title='RAI Assistant']")).toBeVisible({ timeout: 15000 });

  await page.getByTitle('Reset Assistant', { exact: true }).click();
  await expect.poll(() => getChatState(page), { timeout: 60000, intervals: [1000] }).toBe('ready');

  const frame = page.frameLocator("iframe[title='RAI Assistant']");
  await expect(frame.locator('#term')).toBeVisible({ timeout: 30000 });
  await expect(frame.locator('.xterm-helper-textarea')).toBeVisible({ timeout: 30000 });
  await expect.poll(
    () => frame.locator('#term').evaluate(() => (window as any).__raiTerminalConnectionState),
    { timeout: 30000, intervals: [250] },
  ).toBe('connected');

  // A connected websocket does not mean the provider CLI accepts input yet: a
  // real CLI boots, may print update/permission-mode notices, and only then
  // draws its input box. Keystrokes typed before that are silently dropped
  // (live-claude-1, 2026-09-25: typed 2.3s after reset, prompt never sent).
  await expect.poll(
    async () => cliPromptReady(await readLiveTerminal(page)),
    { timeout: 90000, intervals: [500] },
  ).toBe(true);
}

/** Pure: does the terminal text show the CLI's idle input footer? */
export function cliPromptReady(text: string): boolean {
  return /shift\+tab to cycle|\? for shortcuts/.test(text);
}

/** Pure: comparison key tolerant of the TUI's wrapping and box-drawing borders. */
export function terminalKey(text: string): string {
  return text.replace(/[^A-Za-z0-9]/g, '');
}

/** Pure: number of completed CLI turns ("… for 11s · done 5:14 PM"). */
export function completedTurns(text: string): number {
  return (text.match(/for \d+(?:m \d+)?s · done/g) ?? []).length;
}

/**
 * Set the product's Full Auto flag (autoApproveReadOnly) in the sandbox HOME's
 * assistant.json. The native session re-reads it for every proposal (the
 * bridge forces it on only at its own startup), so call this AFTER
 * openFreshLiveRaiAssistant. Returns a restore function.
 */
export function setFullAuto(enabled: boolean): () => void {
  const file = path.join(workerUserHome(), '.raistudio', 'assistant.json');
  const before = fs.readFileSync(file, 'utf8');
  const cfg = JSON.parse(before);
  cfg.autoApproveReadOnly = enabled;
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return () => fs.writeFileSync(file, before);
}

export async function readLiveTerminal(page: Page): Promise<string> {
  const frame = page.frameLocator("iframe[title='RAI Assistant']");
  return frame.locator('#term').evaluate(() => {
    const t = (window as any).__raiTerm;
    if (!t) return '';
    const b = t.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
    return out.join('\n');
  });
}

/**
 * Type a prompt into the live CLI and submit it only after its tail is echoed
 * in the input box, so a dropped keystroke fails fast and visibly here rather
 * than as an 8-minute Console timeout.
 */
export async function submitLivePrompt(page: Page, message: string, delay = 15): Promise<void> {
  const frame = page.frameLocator("iframe[title='RAI Assistant']");
  await frame.locator('.xterm-helper-textarea').click();
  await page.keyboard.type(message, { delay });
  const tail = terminalKey(message).slice(-24);
  await expect.poll(
    async () => terminalKey(await readLiveTerminal(page)).includes(tail),
    { timeout: 15000, intervals: [250] },
  ).toBe(true);
  await page.keyboard.press('Enter');
}
