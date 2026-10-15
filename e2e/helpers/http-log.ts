import type { Locator, Page } from '@playwright/test';

/** Every row of the console's HTTP Log, oldest first. */
export function logRows(page: Page): Locator {
  return page.locator('[data-testid="http-log-row"]');
}

/**
 * Selects a log row, opening its detail pane.
 *
 * The click lands near the row's left edge rather than its centre: selecting a row narrows the
 * table to make room for the detail beside it, and a centre point measured before that reflow can
 * land on the detail pane, which then swallows the click.
 */
export async function selectLogRow(row: Locator): Promise<void> {
  await row.scrollIntoViewIfNeeded();
  await row.click({ position: { x: 8, y: 8 } });
}

/** Opens the HTTP Log's Filters menu, toggles one choice in a group of it, and closes the menu. */
export async function toggleLogFilter(
  page: Page,
  group: 'Method' | 'Status' | 'Protocol',
  name: string,
): Promise<void> {
  await page.getByTestId('http-log-filters').click();
  await page.getByRole('menu').getByRole('group', { name: group }).getByRole('menuitemcheckbox', { name }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'hidden' });
}
