import { expect, type Locator, type Page } from '@playwright/test';

/** Switches the sidebar to the Environments view via the activity bar. */
export async function openEnvironmentsView(page: Page): Promise<void> {
  await page.getByTestId('activity-environments').click();
  await expect(page.getByTestId('environments-view')).toBeVisible();
}

/** The Environments view's row for one workspace environment, matched by its name. */
export function environmentRow(page: Page, name: string): Locator {
  return page.getByTestId('environment-row').filter({ hasText: name });
}

/**
 * Opens one workspace environment's editor tab from the Environments view, by name. Assumes
 * the view is already showing (see {@link openEnvironmentsView}).
 */
export async function openEnvironment(page: Page, name: string): Promise<void> {
  const row = environmentRow(page, name);
  await expect(row).toBeVisible();
  await row.dblclick();
}
