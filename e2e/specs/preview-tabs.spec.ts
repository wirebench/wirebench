/**
 * Preview tabs, the tab menu and the unsaved-close question (#679), end to end.
 *
 * The editors store's own suite proves the preview rules. What only the real app can prove is the chain from
 * a single click in the Explorer to one italic tab that the next click replaces, an edit in the editor
 * keeping that tab, and the tab's right-click menu closing the others — asking first about the one with an
 * unsaved edit.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { apiRow, folderRow, importOpenApiByUrl, restRequestRow, unfoldRow } from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer } from '../helpers/test-server.js';

/** Three operations on one path, so they land in one folder. */
function contract(serverUrl: string): string {
  return `openapi: 3.0.3
info:
  title: Items
  version: '1.0'
servers:
  - url: ${serverUrl}
paths:
  /items:
    get:
      summary: List items
      responses:
        '200': { description: OK }
    post:
      summary: Create item
      responses:
        '201': { description: Created }
    delete:
      summary: Delete items
      responses:
        '204': { description: Deleted }
`;
}

/** The editor tabs on the strip, without the fixed Start tab. */
function editorTabs(page: Page): Locator {
  return page
    .getByRole('tablist', { name: 'Open editors' })
    .getByRole('tab')
    .filter({ hasNotText: /^Start$/ });
}

function editorTab(page: Page, name: string): Locator {
  return page.getByRole('tablist', { name: 'Open editors' }).getByRole('tab', { name });
}

test.describe('Preview tabs', () => {
  let launched: LaunchedApp | undefined;
  let server: TestRestServer | undefined;
  let userDataDir: string | undefined;

  /** A workspace with the three requests imported and their folder unfolded. */
  async function openItems(): Promise<Page> {
    const documents: Record<string, { body: string; contentType: string }> = {};
    server = await startTestRestServer({ documents });
    documents['/openapi.yaml'] = { body: contract(server.url), contentType: 'application/yaml' };
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-preview-tabs-'));
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createWorkspace(page, 'Previews');
    await createProject(page, 'Items');
    await importOpenApiByUrl(page, `${server.url}/openapi.yaml`);
    await expect(apiRow(page, 'Items')).toBeVisible({ timeout: 20_000 });
    await unfoldRow(apiRow(page, 'Items'));
    await expect(folderRow(page, 'items')).toBeVisible({ timeout: 20_000 });
    await folderRow(page, 'items').click();
    await expect(restRequestRow(page, 'List items')).toBeVisible({ timeout: 20_000 });
    return page;
  }

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    await server?.close();
    server = undefined;
    if (userDataDir !== undefined) {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      userDataDir = undefined;
    }
  });

  test('three clicks leave one preview tab, an edit keeps it, and Close others asks about it', async () => {
    const page = await openItems();

    // Three single clicks: one tab, in italics, naming the last request clicked.
    for (const name of ['List items', 'Create item', 'Delete items']) {
      await restRequestRow(page, name).click();
      await expect(page.getByTestId('rest-breadcrumb-name')).toHaveText(name, { timeout: 20_000 });
    }
    await expect(editorTabs(page)).toHaveCount(1);
    const deleteTab = editorTab(page, 'Delete items');
    await expect(deleteTab).toHaveAttribute('data-preview', 'true');

    // An edit keeps the tab: the next click opens a tab beside it.
    await page.getByTestId('rest-url').fill('/items?all=true');
    await page.getByTestId('rest-breadcrumb-name').click();
    await expect(deleteTab.getByTestId('editor-tab-dirty')).toBeVisible();
    await expect(deleteTab).not.toHaveAttribute('data-preview', 'true');
    await restRequestRow(page, 'List items').click();
    await expect(editorTabs(page)).toHaveCount(2);
    await expect(editorTab(page, 'List items')).toHaveAttribute('data-preview', 'true');

    // Close others from the List tab's menu asks about the unsaved edit first; Cancel keeps both.
    await editorTab(page, 'List items').click({ button: 'right' });
    await page.getByTestId('editor-tab-menu-close-others').click();
    const question = page.getByTestId('unsaved-close');
    await expect(question).toBeVisible();
    await expect(question).toContainText('Delete items');
    await page.getByTestId('unsaved-close-cancel').click();
    await expect(question).toHaveCount(0);
    await expect(editorTabs(page)).toHaveCount(2);

    // Don't save closes it, and its edit goes with it.
    await editorTab(page, 'List items').click({ button: 'right' });
    await page.getByTestId('editor-tab-menu-close-others').click();
    await page.getByTestId('unsaved-close-discard').click();
    await expect(editorTabs(page)).toHaveCount(1);
    await expect(editorTab(page, 'List items')).toBeVisible();
    await expect(page.getByTestId('editor-tab-dirty')).toHaveCount(0);

    // A middle-click closes the last one.
    await editorTab(page, 'List items').click({ button: 'middle' });
    await expect(editorTabs(page)).toHaveCount(0);
  });

  test('a double-click keeps the tab, and the setting turns previews off', async () => {
    const page = await openItems();

    await restRequestRow(page, 'List items').dblclick();
    await expect(editorTab(page, 'List items')).toBeVisible({ timeout: 20_000 });
    await expect(editorTab(page, 'List items')).not.toHaveAttribute('data-preview', 'true');
    await restRequestRow(page, 'Create item').click();
    await expect(editorTabs(page)).toHaveCount(2);
    await expect(editorTab(page, 'Create item')).toHaveAttribute('data-preview', 'true');

    // Settings ▸ Behaviour ▸ Preview tabs, off: every click opens a tab of its own.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma');
    await expect(page.getByTestId('preferences-editor')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('preferences-editor').getByRole('button', { name: 'Behaviour', exact: true }).click();
    const toggle = page.getByRole('switch', { name: 'Preview tabs' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-page')).toHaveCount(0);

    await restRequestRow(page, 'Delete items').click();
    await expect(editorTabs(page)).toHaveCount(3);
    await expect(editorTab(page, 'Delete items')).not.toHaveAttribute('data-preview', 'true');
  });
});
