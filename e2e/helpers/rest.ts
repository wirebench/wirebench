/**
 * The gestures a REST spec needs, so each spec reads as what the user did rather than as a list of
 * selectors: make an API, make a request in it, set its method and URL, send it, and look at the
 * response.
 */
import { expect, type Locator, type Page } from '@playwright/test';

/** The platform's own modifier, for the shortcuts a spec presses. */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * Creates an API in the selected project through the project row's context menu, then sets its base
 * URL on the API tab that opens. Returns once the API's explorer row is there.
 */
export async function createApi(page: Page, name: string, baseUrl: string): Promise<void> {
  const projectRow = page.getByTestId('explorer-project-row').first();
  await expect(projectRow).toBeVisible({ timeout: 20_000 });
  await projectRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New API…' }).click();

  // The API tab opens on creation, which is where its name and base URL are edited.
  await expect(page.getByTestId('api-tab')).toBeVisible({ timeout: 20_000 });
  const nameField = page.getByTestId('api-name');
  await nameField.fill(name);
  await nameField.press('Enter');
  const baseUrlField = page.getByTestId('api-base-url');
  await baseUrlField.fill(baseUrl);
  await baseUrlField.press('Enter');

  await expect(page.getByTestId('api-row').filter({ hasText: name })).toBeVisible({ timeout: 20_000 });
}

/** The explorer row for one API. */
export function apiRow(page: Page, name: string): Locator {
  return page.getByTestId('api-row').filter({ hasText: name });
}

/**
 * Creates a REST request at the root of `apiName` through the API row's context menu, names it, and
 * leaves its editor open.
 */
export async function createRestRequest(page: Page, apiName: string, name: string): Promise<void> {
  const row = apiRow(page, apiName);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New request' }).click();

  await expect(page.getByTestId('rest-editor')).toBeVisible({ timeout: 20_000 });
  // The breadcrumb renames in place on a double-click, which is how a request is named.
  const breadcrumbName = page.getByTestId('rest-breadcrumb-name');
  await breadcrumbName.dblclick();
  const input = page.getByTestId('rest-breadcrumb-name-input');
  await input.fill(name);
  await input.press('Enter');
  await expect(breadcrumbName).toHaveText(name);
}

/** Sets the open REST request's method and URL. */
export async function setMethodAndUrl(page: Page, method: string, url: string): Promise<void> {
  await page.getByTestId('rest-method').selectOption(method);
  const field = page.getByTestId('rest-url');
  await field.fill(url);
  // Blur rather than Enter: Enter in the URL field sends the request.
  await page.getByTestId('rest-breadcrumb-name').click();
  await expect(field).toHaveValue(url);
}

/** One of the request tabs — Params, Headers, Body, Auth, Settings — by its label. */
export async function openRequestTab(page: Page, tab: string): Promise<void> {
  // Scoped to the request tablist: the response pane has tabs of its own, and two of the labels
  // (Headers, Body) appear in both.
  await page.getByRole('tablist', { name: 'Request tabs' }).getByRole('tab', { name: tab }).click();
}

/** Adds one header to the open REST request through the Headers tab's add row. */
export async function addHeader(page: Page, name: string, value: string): Promise<void> {
  await openRequestTab(page, 'Headers');
  await page.getByTestId('rest-header-new-name').fill(name);
  const valueField = page.getByTestId('rest-header-value').last();
  await valueField.fill(value);
  await valueField.press('Enter');
}

/** Sends the open REST request and waits for a status line. */
export async function sendRest(page: Page): Promise<void> {
  await page.getByTestId('rest-send').click();
  await expect(page.getByTestId('rest-response-status')).toBeVisible({ timeout: 20_000 });
}

/** Sends with the keyboard, which is what `rest.send` is bound to. */
export async function sendRestByKeyboard(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+Enter`);
  await expect(page.getByTestId('rest-response-status')).toBeVisible({ timeout: 20_000 });
}

/** The response status line's text. */
export function responseStatus(page: Page): Locator {
  return page.getByTestId('rest-response-status');
}

/** Opens one response tab by its label, e.g. `Headers`, `Cookies`, `Redirects`, `Timing`. */
export async function openResponseTab(page: Page, tab: string): Promise<void> {
  await page
    .getByRole('tablist', { name: 'Response tabs' })
    .getByRole('tab', { name: new RegExp(`^${tab}`) })
    .click();
}

/** Saves the open request with `Mod+S`. */
export async function saveRequest(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+s`);
}

/**
 * Opens the Import OpenAPI dialog from the selected project's context menu, so the import lands in
 * that project rather than in one the dialog invented.
 */
export async function openImportOpenApi(page: Page): Promise<void> {
  const projectRow = page.getByTestId('explorer-project-row').first();
  await expect(projectRow).toBeVisible({ timeout: 20_000 });
  await projectRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Import OpenAPI…' }).click();
  await expect(page.getByTestId('import-openapi-dialog')).toBeVisible({ timeout: 20_000 });
}

/** Imports a document by URL and dismisses the summary, leaving the new API in the explorer. */
export async function importOpenApiByUrl(page: Page, url: string): Promise<void> {
  await openImportOpenApi(page);
  await page.getByTestId('import-openapi-url').fill(url);
  await page.getByTestId('import-openapi-submit').click();
  await expect(page.getByTestId('import-openapi-summary')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('import-openapi-done').click();
  await expect(page.getByTestId('import-openapi-dialog')).toBeHidden();
}

/**
 * A row whose name is exactly `name`, not merely contains it.
 *
 * An imported tree has folders called `json`, `json-sample` and `prefers-json` at once, so a
 * substring match resolves to four rows. The row's own text is no help either — a request row reads
 * `POSTJSON with an example`, badge and label run together — so the match is made against the label
 * element itself, whose text is the name and nothing else.
 */
function rowNamed(page: Page, testId: string, name: string): Locator {
  return page.getByTestId(testId).filter({ has: page.getByText(name, { exact: true }) });
}

/** The explorer row for one folder, by its exact name. */
export function folderRow(page: Page, name: string): Locator {
  return rowNamed(page, 'folder-row', name);
}

/** The explorer row for one imported REST request, by its exact name. */
export function restRequestRow(page: Page, name: string): Locator {
  return rowNamed(page, 'rest-request-row', name);
}

/** Opens the API tab for `name` by double-clicking its explorer row. */
export async function openApiTab(page: Page, name: string): Promise<void> {
  await apiRow(page, name).dblclick();
  await expect(page.getByTestId('api-tab')).toBeVisible({ timeout: 20_000 });
}

/**
 * Configures OAuth2 client credentials on the open API tab against a stub issuer.
 *
 * The client secret goes through the SecretField's own Set…/Save gesture, which is the only way a
 * value reaches the keychain — there is no channel that would accept it any other way.
 */
export async function setApiOAuth2ClientCredentials(
  page: Page,
  options: {
    readonly tokenUrl: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly scopes?: string;
  },
): Promise<void> {
  await page.getByLabel('API authentication type').selectOption('oauth2');
  await page.getByLabel('API token url').fill(options.tokenUrl);
  await page.getByLabel('API client id').fill(options.clientId);
  if (options.scopes !== undefined) {
    await page.getByLabel('API scopes').fill(options.scopes);
  }
  await page.getByRole('button', { name: 'Set…' }).click();
  await page.getByLabel('API client secret').fill(options.clientSecret);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('oauth2-status')).toBeVisible({ timeout: 20_000 });
}

/** The OAuth2 panel's state line. */
export function oauth2State(page: Page): Locator {
  return page.getByTestId('oauth2-state');
}
