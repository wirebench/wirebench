import type { Locator } from '@playwright/test';

/** Picks `action` (Re-send, Compare…, Compare with current, Delete) from a History row's ⋯ menu. */
export async function chooseHistoryRowAction(row: Locator, action: string): Promise<void> {
  await row.getByTestId('history-row-actions').click();
  await row.page().getByRole('menuitem', { name: action, exact: true }).click();
}
