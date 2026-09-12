import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';

test.describe('app smoke', () => {
  let launched: LaunchedApp | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
    }
  });

  test('launches to the picker, and shows the shell once a workspace is open', async () => {
    launched = await launchApp();
    const { window } = launched;

    await expect(window.locator('[data-testid="workspace-picker"]')).toBeVisible();
    await createWorkspace(window);

    await expect(window.locator('[data-testid="title-bar"]')).toBeVisible();
    await expect(window.locator('[data-testid="activity-bar"]')).toBeVisible();
    await expect(window.locator('[data-testid="status-bar"]')).toBeVisible();
  });

  test('command palette opens, lists Import WSDL, and closes on Escape', async () => {
    launched = await launchApp();
    const { window, app } = launched;

    const isMac = await app.evaluate(() => process.platform === 'darwin');
    await window.keyboard.press(isMac ? 'Meta+k' : 'Control+k');

    const paletteOption = window.getByRole('option').filter({ hasText: 'Import WSDL' });
    await expect(paletteOption).toBeVisible();

    await window.keyboard.press('Escape');
    await expect(paletteOption).toHaveCount(0);
  });
});
