// Help items that open Posit-run pages are removed at startup by Application.java.

import { expect } from '@playwright/test';
import { test } from '@fixtures/rstudio.fixture';
import { isCommandVisible } from '@utils/commands';

const REMOVED_HELP_COMMANDS = [
  'showReleaseNotes',
  'whatsNewRStudio',
  'rstudioCommunityForum',
  'openRStudioIDECheatSheet',
  'helpUsingRStudio',
];

test.describe('Help menu removes Posit-run pages', { tag: ['@parallel_safe'] }, () => {

  for (const commandId of REMOVED_HELP_COMMANDS) {
    test(`${commandId} is not visible`, async ({ rstudioPage: page }) => {
      await expect
        .poll(() => isCommandVisible(page, commandId), { timeout: 15000 })
        .toBe(false);
    });
  }
});
