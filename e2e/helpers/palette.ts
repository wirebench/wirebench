import { expect, type Page } from '@playwright/test';

/**
 * Runs a command by its palette label: opens the command palette (Mod+Shift+P), types `name`,
 * and accepts the top match. Returns once the palette has closed again.
 */
export async function runCommand(page: Page, name: string): Promise<void> {
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+P`);
  await expect(page.getByTestId('command-palette-input')).toBeVisible({ timeout: 20_000 });
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('command-palette-input')).toBeHidden({ timeout: 20_000 });
}
