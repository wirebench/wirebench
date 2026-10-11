import { expect, test, type Page } from '@playwright/test';
import { setMonacoText } from '../helpers/editor.js';
import { openEnvironmentsView, setVariable } from '../helpers/environments.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { createApi, createRestRequest, openRequestTab } from '../helpers/rest.js';

/** The slice of the Monaco namespace this spec reads through `globalThis.__wirebenchMonaco`. */
interface MonacoHandle {
  readonly editor: { getModelMarkers(filter: { owner?: string }): { message: string }[] };
}

/** The unresolved-variable marks Monaco holds. */
async function variableMarkers(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const monaco = (globalThis as unknown as { __wirebenchMonaco?: MonacoHandle }).__wirebenchMonaco;
    return monaco?.editor.getModelMarkers({ owner: 'wirebench-variables' }).map((marker) => marker.message) ?? [];
  });
}

/** Sets one Globals variable through the Environments view. */
async function setGlobal(page: Page, name: string, value: string): Promise<void> {
  await openEnvironmentsView(page);
  await page.getByRole('grid', { name: 'Environments' }).getByRole('row').filter({ hasText: 'Globals' }).click();
  await expect(page.getByRole('grid', { name: 'Globals variables' })).toBeVisible({ timeout: 20_000 });
  await setVariable(page, name, value);
  await page.getByTestId('activity-bar').getByRole('button', { name: 'Explorer', exact: true }).click();
}

test.describe('Variables in the editor (#340)', () => {
  let launched: LaunchedApp | undefined;

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
  });

  test('completes ${ in a header, underlines an unresolved name, and marks one in the body', async () => {
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page, 'Vars');
    await createProject(page, 'Pets');
    await setGlobal(page, 'apiHost', 'example.test');
    await createApi(page, 'Petstore', 'http://127.0.0.1:9');
    await createRestRequest(page, 'Petstore', 'Echo');

    // --- completion in a header value -----------------------------------------
    await openRequestTab(page, 'Headers');
    await page.getByTestId('rest-header-new-name').fill('X-Host');
    const value = page.getByTestId('rest-header-value').last();
    await value.fill('${api');
    const list = page.getByRole('listbox', { name: 'Variables' });
    await expect(list.getByRole('option').first()).toContainText('apiHost');
    await value.press('Enter');
    await expect(list).toBeHidden();
    await expect(value).toHaveValue('${apiHost}');
    await value.press('Enter');

    // --- an unresolved name, marked where it is written ------------------------
    await page.getByTestId('rest-header-new-name').fill('X-Other');
    const other = page.getByTestId('rest-header-value').last();
    await other.fill('${nope}');
    await other.press('Enter');
    await page.getByTestId('rest-breadcrumb-name').click();
    const headers = page.getByRole('grid', { name: 'Request headers' });
    await expect(headers.locator('[data-unresolved]')).toHaveText('${nope}');
    await expect(headers.locator('[data-variable-start]:not([data-unresolved])')).toHaveText('${apiHost}');

    // --- the same in the raw body, as a Monaco marker --------------------------
    await openRequestTab(page, 'Body');
    await page.getByTestId('rest-body-kind').selectOption('raw');
    await setMonacoText(page, 'Request body', '{"host": "${apiHost}", "bad": "${nope}"}');
    await expect.poll(() => variableMarkers(page), { timeout: 10_000 }).toEqual(['Unresolved variable "nope"']);
  });
});
