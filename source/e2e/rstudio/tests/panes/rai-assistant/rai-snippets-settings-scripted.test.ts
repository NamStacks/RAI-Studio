import * as fs from 'node:fs';
import { test, expect } from '@fixtures/rstudio.fixture';
import { executeCommand, getChatState } from '@utils/commands';
import { setupScriptedRaiTest, teardownScriptedRaiTest } from './scripted-rai.fixture';

test('Snippet Settings: editable defaults, keyboard order, safe pending draft and deferred restart @serial', async ({ rstudioPage: page }, testInfo) => {
  test.setTimeout(180000);
  const fixture = await setupScriptedRaiTest('snippets-settings', 'fake-claude-provider-scoped-media.mjs', {});
  try {
    await page.evaluate(file => (window as any).rstudio.project.open(file), fixture.projectFile);
    await page.waitForFunction(({ projectPath }) => (window as any).rstudio?.ready === true &&
      (window as any).rstudio?.project?.path?.() === projectPath,
      { projectPath: fixture.projectPath }, { timeout: 60000 });
    await executeCommand(page, 'activateChat');
    await expect.poll(() => getChatState(page), { timeout: 60000 }).toBe('ready');
    const frame = page.frameLocator("iframe[title='RAI Assistant']");
    const panel = frame.locator('#settings-panel');
    const openSettings = async () => {
      await page.getByRole('button', { name: 'RAI Assistant settings' }).click();
      await expect(panel).toBeVisible();
    };
    await openSettings();
    await panel.evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)); });
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    await panel.screenshot({ path: testInfo.outputPath('general-dark.png') });
    await expect(frame.locator('#settings-rai-policy-hint')).toContainText('approved automatically');
    await frame.locator('#settings-tab-global').click();
    expect(await panel.boundingBox()).toEqual(box);
    await expect(frame.locator('#settings-global')).toContainText('Save stores changes');
    await panel.screenshot({ path: testInfo.outputPath('global-dark.png') });
    await frame.locator('#settings-tab-snippets').click();
    expect(await panel.boundingBox()).toEqual(box);
    await panel.screenshot({ path: testInfo.outputPath('snippets-dark.png') });
    await frame.locator('#settings-tab-general').click();
    const chips = frame.locator('#settings-provider-list .native-cli');
    await expect(chips).toHaveCount(4); // Every native CLI is listed with its sign-in state.
    for (const name of ['Claude Code', 'Codex CLI', 'OpenCode', 'Grok Build']) await expect(chips.filter({ hasText: name })).toHaveCount(1);
    await expect(frame.locator('#settings-provider-list .native-cli[aria-pressed="true"]')).toHaveCount(1);
    await frame.locator('#settings-provider-list').screenshot({ path: testInfo.outputPath('native-cli-chips-dark.png') });
    await frame.locator('#settings-theme-light').click();
    await frame.locator('#settings-provider-list').scrollIntoViewIfNeeded();
    await frame.locator('#settings-provider-list').screenshot({ path: testInfo.outputPath('native-cli-chips-light.png') });
    await panel.screenshot({ path: testInfo.outputPath('general-light.png') });
    await frame.locator('#settings-tab-global').click();
    await panel.screenshot({ path: testInfo.outputPath('global-light.png') });
    await frame.locator('#settings-tab-snippets').click();
    await panel.screenshot({ path: testInfo.outputPath('snippets-light.png') });
    await frame.locator('#settings-tab-general').click();
    await frame.locator('#settings-theme-dark').click();
    await expect(frame.locator('#settings-general select')).toHaveCount(0);
    await expect(frame.locator('#settings-save-on-edit')).toHaveCount(0);
    await frame.locator('#settings-fontsize-14').click();
    await expect(frame.locator('#settings-fontsize-14')).toHaveAttribute('aria-pressed', 'true');
    await expect(frame.locator('#settings-fontsize')).toHaveValue('14');
    await frame.locator('#settings-tab-snippets').click();
    const first = frame.getByRole('option', { name: 'Explain code' });
    const second = frame.getByRole('option', { name: 'Debug' });
    await first.click();
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await first.focus();
    await first.press('ArrowDown');
    await expect(second).toHaveAttribute('aria-selected', 'true');
    await expect(second).toHaveAttribute('tabindex', '0');
    await second.press('Home');
    await expect(first).toHaveAttribute('aria-selected', 'true');
    for (let i = 0; i < 3; i++) {
      await frame.getByRole('option').last().click();
      await frame.locator('#snippet-delete').click();
      await frame.locator('#snippet-delete').click();
    }
    await expect(frame.getByRole('option')).toHaveCount(2);
    for (let i = 0; i < 3; i++) {
      await frame.locator('#settings-add-snippet').click();
      await frame.locator('#snippet-edit-name').fill(`Long ${i} ${'scientific analysis '.repeat(3)}`.slice(0, 48));
      await frame.locator('#snippet-edit-prompt').fill(`Example ${i}`);
    }
    await expect(frame.getByRole('option')).toHaveCount(5);
    await panel.screenshot({ path: testInfo.outputPath('snippets-five-long.png') });
    const iframe = page.locator("iframe[title='RAI Assistant']");
    const iframeSize = await iframe.evaluate(el => {
      const box = el.getBoundingClientRect();
      return { width: el.style.width, height: el.style.height, boxWidth: box.width, boxHeight: box.height };
    });
    await iframe.evaluate(el => { el.style.width = '320px'; el.style.height = '330px'; });
    await expect.poll(() => frame.locator('body').evaluate(() => window.innerWidth)).toBeLessThanOrEqual(320);
    const footerVisible = await panel.evaluate(el =>
      (el.querySelector('#settings-actions') as HTMLElement).getBoundingClientRect().bottom <=
      el.getBoundingClientRect().bottom + 1);
    expect(footerVisible).toBe(true);
    await panel.screenshot({ path: testInfo.outputPath('snippets-narrow-large-font.png') });
    await frame.locator('#settings-add-snippet').scrollIntoViewIfNeeded();
    await expect(frame.locator('#settings-add-snippet')).toBeInViewport();
    const addClearOfFooter = await frame.locator('#settings-add-snippet').evaluate(el =>
      el.getBoundingClientRect().bottom <=
      document.querySelector('#settings-actions')!.getBoundingClientRect().top + 1);
    expect(addClearOfFooter).toBe(true);
    await panel.screenshot({ path: testInfo.outputPath('snippets-narrow-scrolled.png') });
    await iframe.evaluate((el, size) => {
      el.style.width = size.width || `${size.boxWidth}px`;
      el.style.height = size.height || `${size.boxHeight}px`;
    }, iframeSize);
    await expect.poll(() => frame.locator('body').evaluate(() => window.innerHeight)).toBeGreaterThan(200);
    await frame.locator('#settings-cancel').click();
    await expect(frame.locator('#settings-close-confirm')).toBeVisible();
    await panel.screenshot({ path: testInfo.outputPath('snippets-dirty-close.png') });
    await frame.locator('#settings-confirm-discard').click();
    await openSettings();
    await frame.locator('#settings-tab-snippets').click();
    while (await frame.getByRole('option').count() > 0) {
      await frame.getByRole('option').first().click();
      await frame.locator('#snippet-delete').click();
      await frame.locator('#snippet-delete').click();
    }
    await expect(frame.getByRole('option')).toHaveCount(0);
    await expect(frame.locator('#settings-add-snippet')).toBeEnabled();
    await panel.screenshot({ path: testInfo.outputPath('snippets-empty.png') });
    await frame.locator('#settings-cancel').click();
    await frame.locator('#settings-confirm-discard').click();
    await openSettings();
    await frame.locator('#settings-tab-snippets').click();
    await frame.locator('#snippet-edit-name').fill('Scientific comments');
    const custom = 'Custom writing  two spaces and <tags> literal. No change to original data.';
    await frame.locator('#snippet-edit-prompt').fill(custom);
    await frame.locator('#settings-save').click();
    await expect(panel).toBeHidden();
    const shortcut = frame.getByRole('button', { name: 'Insert Scientific comments into the provider composer; not sent' });
    await expect(shortcut).toBeVisible();
    await openSettings();
    await frame.locator('#settings-tab-snippets').click();
    await expect(frame.locator('#snippet-edit-prompt')).toHaveValue(custom);
    await frame.locator('#snippet-edit-name').fill('   ');
    await frame.locator('#settings-save').click();
    await expect(frame.locator('#settings-error')).toContainText('name');
    await panel.screenshot({ path: testInfo.outputPath('snippets-validation-error.png') });
    await frame.locator('#snippet-edit-name').fill('Scientific comments');
    await frame.locator('#settings-reset-snippets').click();
    await expect(frame.locator('#snippet-edit-name')).toHaveValue('Scientific comments');
    await frame.locator('#settings-reset-snippets').click();
    await expect(frame.getByRole('option', { name: 'Explain code' })).toHaveAttribute('aria-selected', 'true');
    await frame.locator('#settings-cancel').click();
    await frame.locator('#settings-confirm-discard').click();
    await expect(shortcut).toBeVisible();
    const shortcutHitTarget = await shortcut.evaluate(el => {
      const box = el.getBoundingClientRect();
      return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === el;
    });
    expect(shortcutHitTarget).toBe(true); // The shortcut row must not clip its own hit target.
    await expect.poll(() => frame.locator('body').evaluate(() => (window as any).__raiComposerReady === true), { timeout: 30000 }).toBe(true);
    await shortcut.click();
    const pending = frame.locator('#pending-draft-text');
    const raw = `${fixture.stateDir}/draft-input.bin`;
    await expect.poll(() => fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8') : '', { timeout: 15000 }).toBe(custom);
    expect(fs.readFileSync(raw).includes(13)).toBe(false);
    await expect(frame.locator('#pending-draft')).toBeHidden();
    fs.writeFileSync(`${fixture.stateDir}/emit-busy`, '1');
    await expect.poll(() => frame.locator('body').evaluate(() => (window as any).__raiComposerReady === false), { timeout: 15000 }).toBe(true);
    await shortcut.click();
    await expect(pending).toHaveValue(custom);
    await expect(frame.locator('#pending-insert')).toHaveCount(0); // Queued drafts insert automatically; no extra click.
    const pendingControlsVisible = await frame.locator('#pending-draft').evaluate(el => {
      const panelBox = el.getBoundingClientRect();
      const label = el.querySelector('label')!.getBoundingClientRect();
      const undo = el.querySelector('#pending-undo')!.getBoundingClientRect();
      return label.top >= panelBox.top && undo.bottom <= panelBox.bottom + 1;
    });
    expect(pendingControlsVisible).toBe(true); // Not sent and Undo stay visible at the small pane height.
    await frame.locator('#pending-draft').screenshot({ path: testInfo.outputPath('pending-busy-not-sent.png') });
    await openSettings();
    await frame.locator('#settings-theme-light').click();
    await frame.locator('#settings-cancel').click();
    await expect(frame.locator('#settings-close-confirm')).toBeVisible();
    await frame.locator('#pending-draft').screenshot({ path: testInfo.outputPath('pending-busy-light-not-sent.png') });
    await frame.locator('#settings-confirm-discard').click();
    await expect(panel).toBeHidden();
    await openSettings();
    await frame.locator('#settings-theme-dark').click();
    await frame.locator('#settings-cancel').click();
    if (await frame.locator('#settings-close-confirm').isVisible()) {
      await frame.locator('#settings-confirm-discard').click();
    }
    await expect(panel).toBeHidden();
    await pending.fill(`prefix ${custom}`);
    await pending.fill(`prefix ${custom} suffix`);
    await frame.locator('#pending-undo').click();
    await expect(pending).toHaveValue('prefix  suffix');
    await shortcut.click();
    await expect(pending).toHaveValue(`prefix  suffix\n${custom}`);
    await expect(frame.locator('#pending-draft')).toBeVisible(); // Still busy: the draft waits.
    fs.writeFileSync(raw, '');
    fs.rmSync(`${fixture.stateDir}/emit-busy`);
    await expect(frame.locator('#pending-draft')).toBeHidden({ timeout: 30000 }); // Idle again: it inserts on its own.
    await expect.poll(() => fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8') : '', { timeout: 15000 }).toContain(custom);
    expect(fs.readFileSync(raw, 'utf8')).toBe(`\x1b[200~prefix  suffix\n${custom}\x1b[201~`);
    expect(fs.readFileSync(raw).includes(13)).toBe(false); // Still no submission.
    await openSettings();
    await frame.locator('#settings-tab-global').click();
    const oldPid = fs.readFileSync(`${fixture.stateDir}/provider.pid`, 'utf8');
    await frame.locator('#settings-global-prompt').fill('Shared instructions, saved but deferred');
    await frame.locator('#settings-save').click();
    expect(fs.readFileSync(`${fixture.stateDir}/provider.pid`, 'utf8')).toBe(oldPid);
    await expect(frame.locator('#restart-pending')).toBeVisible();
    await expect.poll(() => frame.locator('#restart-pending').isEnabled(), { timeout: 30000 }).toBe(true);
    await frame.locator('#restart-pending').click();
    await expect(frame.locator('#restart-pending')).toHaveText('Confirm restart');
    await frame.locator('#restart-pending').click();
    await expect.poll(() => fs.readFileSync(`${fixture.stateDir}/provider.pid`, 'utf8'), { timeout: 30000 }).not.toBe(oldPid);
    await openSettings();
    await frame.locator('#settings-tab-global').click();
    await expect(frame.locator('#settings-global-prompt')).toHaveValue('Shared instructions, saved but deferred');
    await frame.locator('#settings-cancel').click();
  } finally { await teardownScriptedRaiTest(page, fixture.stateDir); }
});
