import { expect, type Page } from '@playwright/test';
import type { TestSoapServer } from './test-server.js';

export interface CreateProjectOptions {
  /** Asserted against the pre-filled name field, which defaults to the chosen folder's name. */
  readonly expectProjectName?: string;
}

/**
 * Drives the Welcome screen through "New project" and then "Import WSDL" against `server`,
 * returning once the imported `Request 1` is visible in the explorer. The project folder is
 * whatever `launchApp({ folderDialogPath })` pinned the folder picker to.
 */
export async function createProjectWithCalculator(
  page: Page,
  server: TestSoapServer,
  options: CreateProjectOptions = {},
): Promise<void> {
  await page.getByTestId('welcome-new-project').click();
  const nameField = page.getByTestId('new-project-name');
  await expect(nameField).toBeVisible();
  if (options.expectProjectName !== undefined) {
    await expect(nameField).toHaveValue(options.expectProjectName);
  }
  await page.getByTestId('new-project-create').click();

  await page.getByTestId('welcome-import').click();
  await page.getByTestId('import-url-input').fill(server.wsdlUrl);
  await page.getByTestId('import-submit').click();

  await expect(page.locator('[data-testid="explorer-tree-row"]', { hasText: 'Request 1' }).first()).toBeVisible({
    timeout: 20_000,
  });
}

/**
 * The same flow as {@link createProjectWithCalculator}, for a server started with a different
 * `fixture`. The fixture is chosen when the server starts (`startTestSoapServer({ fixture })`),
 * so `name` only names it for the reader — what is imported is whatever `server.wsdlUrl` serves.
 */
export async function createProjectWithFixture(
  page: Page,
  server: TestSoapServer,
  name: string,
  options: CreateProjectOptions = {},
): Promise<void> {
  void name;
  await createProjectWithCalculator(page, server, options);
}

/** Opens the first `Request 1` in the explorer through its context menu (react-arborist owns double-click). */
export async function openFirstRequest(page: Page): Promise<void> {
  const row = page.locator('[data-testid="explorer-tree-row"]', { hasText: 'Request 1' }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open', exact: true }).click();
  await expect(page.getByTestId('request-editor')).toBeVisible({ timeout: 20_000 });
}
