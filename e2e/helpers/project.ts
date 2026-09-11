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
 * Every crafted fixture's `wsdl:service` name — what the explorer shows for it after import
 * (`toInterfaceSummary` falls back to `definition.services[0].name.localName`), keyed by the
 * fixture id a spec passes to `startTestSoapServer({ fixture })`.
 */
const FIXTURE_INTERFACE_NAMES: Readonly<Record<string, string>> = {
  'ws-addressing': 'WsAddressingService',
};

/**
 * The same flow as {@link createProjectWithCalculator}, for a server started with a different
 * `fixture`. The fixture is chosen when the server starts (`startTestSoapServer({ fixture })`),
 * so this can't *select* the fixture by `name` — what is imported is whatever `server.wsdlUrl`
 * serves. What it can (and must) do is check that the server actually served the fixture the
 * spec asked for, by asserting the explorer shows that fixture's interface name once the import
 * settles, instead of silently accepting whatever came back.
 */
export async function createProjectWithFixture(
  page: Page,
  server: TestSoapServer,
  name: string,
  options: CreateProjectOptions = {},
): Promise<void> {
  await createProjectWithCalculator(page, server, options);
  const interfaceName = FIXTURE_INTERFACE_NAMES[name];
  if (interfaceName !== undefined) {
    await expect(page.locator('[data-testid="explorer-tree-row"]', { hasText: interfaceName }).first()).toBeVisible({
      timeout: 20_000,
    });
  }
}

/** Opens the first `Request 1` in the explorer through its context menu (react-arborist owns double-click). */
export async function openFirstRequest(page: Page): Promise<void> {
  const row = page.locator('[data-testid="explorer-tree-row"]', { hasText: 'Request 1' }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open', exact: true }).click();
  await expect(page.getByTestId('request-editor')).toBeVisible({ timeout: 20_000 });
}
