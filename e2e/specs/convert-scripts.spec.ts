/**
 * Converting imported scripts to Wirebench scripts (convert-imported-scripts spec §4, §12), end to end.
 *
 * The engine suites prove the rewrite and the project edit, and the renderer suites the review; what
 * only the real app can prove is the whole gesture: the crafted Bruno collection is imported, its
 * REST API's **Convert scripts…** opens the review with every level the API holds, each proposal
 * type-checks clean with main's own checker, Accept switches the levels and reports them, and the
 * request's Scripts tab then holds a typed script.
 */
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, openImportDialog, saveAll } from '../helpers/project.js';
import {
  apiRow,
  chooseContextMenuItem,
  folderRow,
  openRequestTab,
  restRequestRow,
  unfoldRow,
} from '../helpers/rest.js';
import { selectTab } from '../helpers/tabs.js';

/** The collection the converter's fixture tests use: a collection pre-request script and a request's post-response one. */
const COLLECTION = fileURLToPath(new URL('../../fixtures/bruno/crafted/basic', import.meta.url));

/**
 * The text of the open post-response script's Monaco model, read through the e2e Monaco handle, or
 * undefined while none is open. Only a typed script's model path ends in `.ts`
 * (`scriptModelPath`), and the review's diff models live elsewhere, so a hit is the Scripts tab's.
 */
function typedPostScript(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const monaco = (
      globalThis as unknown as {
        __wirebenchMonaco?: { editor: { getModels(): { uri: { path: string }; getValue(): string }[] } };
      }
    ).__wirebenchMonaco;
    return monaco?.editor
      .getModels()
      .find((model) => model.uri.path.includes('wirebench-script/') && model.uri.path.endsWith('/post.ts'))
      ?.getValue();
  });
}

test.describe('Convert imported scripts', () => {
  let launched: LaunchedApp | undefined;

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
  });

  test('converts a Bruno API from the tree, and the request then has a typed script', async () => {
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page);
    await createProject(page, 'Clients');

    // Folder… goes through main's own folder dialog, stubbed here to the fixture collection.
    await launched.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, COLLECTION);
    await openImportDialog(page);
    await page.getByRole('tab', { name: 'File' }).click();
    await page.getByTestId('import-browse-folder').click();
    await expect(page.getByTestId('detected-format-badge')).toHaveText('Bruno collection', { timeout: 20_000 });
    await page.getByTestId('import-submit').click();
    await expect(page.getByTestId('import-client-summary')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('import-done').click();

    // The REST API is the first of the collection's APIs; unfold it and its folder for later.
    const api = apiRow(page, 'demo-collection').first();
    await unfoldRow(api);
    await expect(folderRow(page, 'Users')).toBeVisible({ timeout: 20_000 });
    await folderRow(page, 'Users').click();
    await expect(restRequestRow(page, 'Create user')).toBeVisible({ timeout: 20_000 });

    // Accept refuses a project with unsaved edits, so the import is saved first.
    await saveAll(page);

    await chooseContextMenuItem(page, api, 'Convert scripts…');
    const dialog = page.getByTestId('convert-scripts-dialog');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    const rows = dialog.getByTestId('convert-scripts-row');
    // The API's own pre-request script and Create user's post-response one.
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    await expect(rows.filter({ hasText: 'Create user' })).toHaveCount(1);

    // Every row converts with nothing left to do, and its proposal type-checks clean: each phase's
    // "No problems." under the diff is main's own checker run over the proposed text.
    for (let row = 0; row < 2; row += 1) {
      const entry = rows.nth(row);
      await expect(entry.getByRole('checkbox')).toBeChecked();
      await expect(entry).toContainText('Bruno · No TODOs');
      const select = entry.getByRole('button');
      await select.click();
      await expect(select).toHaveAttribute('aria-current', 'true');
      const phases = dialog.locator('[data-testid^="convert-scripts-phase-"]');
      // Each level of the fixture has one phase: the API's pre-request script, Create user's post-response one.
      await expect(phases).toHaveCount(1, { timeout: 30_000 });
      await expect(phases.first()).toContainText('No problems.');
    }

    await dialog.getByTestId('convert-scripts-accept').click();
    const applied = dialog.getByTestId('convert-scripts-report-applied');
    await expect(applied).toBeVisible({ timeout: 30_000 });
    await expect(applied).toContainText('Create user');
    await expect(applied).toContainText('imported-scripts/');
    await expect(dialog.getByTestId('convert-scripts-report-refused')).toHaveCount(0);
    await dialog.getByTestId('convert-scripts-close').click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });

    await restRequestRow(page, 'Create user').dblclick();
    await expect(page.getByTestId('rest-editor')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('rest-breadcrumb-name')).toHaveText('Create user');
    await openRequestTab(page, 'Scripts');
    const tab = page.getByTestId('scripts-tab');
    await expect(tab).toBeVisible({ timeout: 20_000 });
    // The level is typed now: no layer label, no Convert button, and its scripts stay off as imported.
    await expect(tab).toContainText('TypeScript', { timeout: 20_000 });
    await expect(tab).not.toContainText('Bruno layer');
    await expect(page.getByTestId('scripts-convert')).toHaveCount(0);
    await expect(page.getByTestId('scripts-off-banner')).toBeVisible();

    await selectTab(page, 'Scripts', /^Post-response/);
    await expect(page.locator('[aria-label="Post-response script"]')).toBeAttached({ timeout: 20_000 });
    await expect
      .poll(() => typedPostScript(page), { timeout: 20_000 })
      .toContain('// Converted from a bruno script; the original is in imported-scripts/');
    const text = (await typedPostScript(page)) ?? '';
    expect(text).toContain('vars.set("userId", (response.json() as any).id);');
    expect(text).toContain('expect(response.status).toBe(201);');
    // The proof that the proposal type-checks is the review's "No problems." above; the tab's own
    // checker line stays empty for the saved script too.
    await expect(page.getByTestId('script-errors')).toHaveCount(0);
  });
});
