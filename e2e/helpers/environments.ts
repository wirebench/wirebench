import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Switches the sidebar to the Environments view via the activity bar. A no-op when it is
 * already showing: the activity bar's own icon collapses the sidebar on a second click (the
 * same "click the active view again" behaviour VS Code's does), so calling this a second time
 * while the view is already open must not toggle it away.
 */
export async function openEnvironmentsView(page: Page): Promise<void> {
  if (await page.getByTestId('environments-view').isVisible()) {
    return;
  }
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

/**
 * The open environment page's variables table row for `name` — an existing row matched by its
 * current name value — or `undefined` when there is none yet.
 */
async function variableRow(page: Page, name: string): Promise<Locator | undefined> {
  const rows = page.getByTestId('env-variable-row');
  const count = await rows.count();
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    if ((await row.getByTestId('env-variable-name').inputValue()) === name) {
      return row;
    }
  }
  return undefined;
}

/**
 * Sets one variable's value on the currently open environment page (an environment, Globals or
 * Workspace), adding it through the always-present add row when it does not exist yet.
 */
export async function setVariable(page: Page, name: string, value: string): Promise<void> {
  let row = await variableRow(page, name);
  if (row === undefined) {
    row = page.getByTestId('env-variable-row').last();
    const nameInput = row.getByTestId('env-variable-name');
    await nameInput.fill(name);
    await nameInput.press('Tab');
  }
  const valueInput = row.getByTestId('env-variable-value');
  await valueInput.fill(value);
  await valueInput.press('Enter');
}

/** Toggles one variable's Enabled checkbox on the currently open environment page. */
export async function toggleVariable(page: Page, name: string): Promise<void> {
  const row = await variableRow(page, name);
  expect(row).toBeDefined();
  await row?.getByTestId('env-variable-enabled').click();
}
