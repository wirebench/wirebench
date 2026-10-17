/**
 * Imported Bruno scripts run (script layers), from the UI against a real server.
 *
 * A collection picked with Folder… arrives with its scripts attached and switched off. Once the two
 * requests' scripts are turned on in their Scripts tabs, running the API from the Runner makes the
 * first request's post-response script store a value that the second request's own test then reads
 * with `bru.getVar`. Reading it in a test, not in a header template, keeps the proof free of any
 * edit to the import: a script's write is read back as `${#Sequence#name}` in a template, which an
 * imported `{{name}}` is not rewritten to.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, openImportDialog } from '../helpers/project.js';
import { apiRow, chooseContextMenuItem, openRequestTab, restRequestRow } from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer } from '../helpers/test-server.js';

let server: TestRestServer;
let app: LaunchedApp | undefined;

test.beforeAll(async () => {
  server = await startTestRestServer({});
});

test.afterAll(async () => {
  await server.close();
});

test.afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** A two-request Bruno collection whose second request tests the value the first one's script stored. */
function writeCollection(url: string): string {
  const root = mkdtempSync(join(tmpdir(), 'wirebench-e2e-bruno-scripts-'));
  const request = (name: string, seq: number, blocks: string): string =>
    `meta {\n  name: ${name}\n  type: http\n  seq: ${String(seq)}\n}\n\nget {\n  url: ${url}/echo\n  body: none\n  auth: none\n}\n\n${blocks}`;
  writeFileSync(join(root, 'bruno.json'), JSON.stringify({ version: '1', name: 'script-demo', type: 'collection' }));
  writeFileSync(
    join(root, 'create-user.bru'),
    request('Create user', 1, 'script:post-response {\n  bru.setVar("userId", "u-" + res.getStatus());\n}\n'),
  );
  writeFileSync(
    join(root, 'get-user.bru'),
    request(
      'Get user',
      2,
      'tests {\n  test("sees the id the first request stored", function () {\n    expect(bru.getVar("userId")).to.equal("u-200");\n  });\n}\n',
    ),
  );
  return root;
}

/** True when the "Run these scripts" control is on, whether it is drawn as a checkbox or a switch. */
const isOn = (toggle: Locator): Promise<boolean> =>
  toggle.evaluate((el) => (el instanceof HTMLInputElement ? el.checked : el.getAttribute('aria-checked') === 'true'));

test('imported Bruno scripts, once switched on, share a value across a run', async () => {
  const collection = writeCollection(server.url);
  app = await launchApp();
  const page = app.window;
  await createWorkspace(page);
  await createProject(page, 'Clients');

  // Folder… goes through main's own folder dialog, stubbed here to the collection above.
  await app.app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
  }, collection);
  await openImportDialog(page);
  await page.getByRole('tab', { name: 'File' }).click();
  await page.getByTestId('import-browse-folder').click();
  await expect(page.getByTestId('detected-format-badge')).toHaveText('Bruno collection', { timeout: 20_000 });
  await page.getByTestId('import-submit').click();
  await expect(page.getByTestId('import-client-summary')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('import-done').click();

  await expect(apiRow(page, 'script-demo').first()).toBeVisible({ timeout: 20_000 });
  await apiRow(page, 'script-demo').first().click();

  // Both requests arrive with their scripts attached and off: turn each on.
  for (const name of ['Create user', 'Get user']) {
    await restRequestRow(page, name).dblclick();
    await expect(page.getByTestId('rest-editor')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('rest-breadcrumb-name')).toHaveText(name);
    await openRequestTab(page, 'Scripts');
    const toggle = page.getByTestId('scripts-enabled');
    await expect(toggle).toBeVisible({ timeout: 20_000 });
    expect(await isOn(toggle)).toBe(false);
    await toggle.click();
    await expect(async () => {
      expect(await isOn(toggle)).toBe(true);
    }).toPass({ timeout: 20_000 });
  }

  await chooseContextMenuItem(page, apiRow(page, 'script-demo').first(), 'Run…');
  const tab = page.getByTestId('runner-tab');
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await expect(tab.getByTestId('runner-request')).toHaveCount(2);
  await tab.getByTestId('runner-run').click();
  // Two requests, both passing: the second one's test only passes if the first one's script ran.
  await expect(tab.getByTestId('runner-status')).toContainText('2 passed, 0 failed, 0 errored', { timeout: 30_000 });
});
