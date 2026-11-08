import { expect, type Page } from '@playwright/test';

/**
 * Runs a command by its palette label: opens the command palette (Mod+Shift+P), types `name`,
 * and accepts the top match. Returns once the palette has closed again.
 */
export async function runCommand(page: Page, name: string): Promise<void> {
  const mac = process.platform === 'darwin';
  const input = page.getByTestId('command-palette-input');
  await page.keyboard.press(`${mac ? 'Meta' : 'Control'}+Shift+P`);
  try {
    await expect(input).toBeVisible({ timeout: 3_000 });
  } catch {
    // The page picks Mod from its own user agent, not this machine: the browser suite's Desktop Chrome device says
    // Windows, so on a Mac its tabs want Ctrl. Press the other one.
    await page.keyboard.press(`${mac ? 'Control' : 'Meta'}+Shift+P`);
  }
  await expect(input).toBeVisible({ timeout: 20_000 });
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('command-palette-input')).toBeHidden({ timeout: 20_000 });
}
