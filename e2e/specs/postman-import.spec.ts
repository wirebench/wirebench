/**
 * Importing a Postman collection, and a Postman environment, end to end.
 *
 * The unit suites prove the mapping and the summary; what only the real app can prove is that the
 * warnings the engine words for a collection cross the IPC boundary and are in front of the user
 * when the import finishes, rather than counted and dropped on the way.
 */
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, openImportDialog } from '../helpers/project.js';
import { apiRow } from '../helpers/rest.js';

/** A collection with the two things a switcher most often loses: a test script and a password. */
const COLLECTION = JSON.stringify({
  info: {
    name: 'Pets',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [{ key: 'baseUrl', value: 'https://pets.example.com' }],
  auth: {
    type: 'basic',
    basic: [
      { key: 'username', value: 'ada' },
      { key: 'password', value: 'not-copied' },
    ],
  },
  item: [
    {
      name: 'List pets',
      event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => {});'] } }],
      request: { method: 'GET', url: '{{baseUrl}}/pets' },
    },
  ],
});

/** An environment export with one plain value and one secret, as Postman writes it. */
const ENVIRONMENT = JSON.stringify({
  name: 'Staging',
  _postman_variable_scope: 'environment',
  values: [
    { key: 'host', value: 'https://staging.example.com', type: 'default', enabled: true },
    { key: 'token', value: 't0k', type: 'secret', enabled: true },
  ],
});

test.describe('Postman import', () => {
  let launched: LaunchedApp | undefined;

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
  });

  test('shows what the collection did not bring across, and imports the rest', async () => {
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page);
    await createProject(page, 'Switching');

    await openImportDialog(page, 'postman');
    await page.getByRole('tab', { name: 'Paste' }).click();
    await page.getByTestId('import-postman-paste').fill(COLLECTION);
    await page.getByTestId('import-postman-submit').click();

    await expect(page.getByTestId('import-postman-counts')).toContainText('1 request');
    const warnings = page.getByTestId('import-postman-warnings');
    await expect(warnings).toContainText('Scripts on 1 request was imported switched off');
    await expect(warnings).toContainText('Credentials are not copied');
    await expect(page.getByTestId('import-postman-copy-report')).toBeVisible();

    await page.getByTestId('import-postman-done').click();
    await expect(apiRow(page, 'Pets')).toBeVisible();
  });

  test('imports a Postman environment as a workspace environment with its secret stored', async () => {
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page, 'Imports');
    await createProject(page, 'Switching');

    await openImportDialog(page);
    await page.getByTestId('import-format-select').selectOption('postman-environment');
    // An environment lands in the workspace, so there is no project to pick.
    await expect(page.getByTestId('import-target-project')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Paste' }).click();
    await page.getByTestId('import-paste').fill(ENVIRONMENT);
    await page.getByTestId('import-submit').click();

    const summary = page.getByTestId('import-variables-summary');
    await expect(summary).toContainText('Staging (2 variables)');
    await expect(summary).toContainText('1 secret stored');
  });
});
