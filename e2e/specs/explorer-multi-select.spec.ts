/**
 * The Explorer follows desktop selection conventions (#681): Shift-click selects a range, the range gets a
 * menu of its own whose **Move to…** moves every selected request, and F2 starts an inline rename.
 */
import { expect, test, type Locator } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import {
  apiRow,
  chooseContextMenuItem,
  createApi,
  createRestRequest,
  folderRow,
  nameNewRow,
  restRequestRow,
  unfoldRow,
} from '../helpers/rest.js';

/** The `treeitem` around a row, which carries `aria-selected` and `aria-level`. */
function treeItem(row: Locator): Locator {
  return row.locator('xpath=ancestor::*[@role="treeitem"][1]');
}

test.describe('Explorer: multi-selection and keys', () => {
  let launched: LaunchedApp | undefined;

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
  });

  test('Shift-click selects three rows, Move to… moves them into a folder, and F2 renames', async () => {
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page);
    await createProject(page, 'Alpha');
    await createApi(page, 'Pets', 'http://localhost:9');
    await chooseContextMenuItem(page, apiRow(page, 'Pets'), 'New folder');
    await nameNewRow(page, 'Archive');
    for (const name of ['One', 'Two', 'Three']) {
      await createRestRequest(page, 'Pets', name);
    }
    await expect(restRequestRow(page, 'Three')).toBeVisible({ timeout: 20_000 });

    // Shift-click from the first request to the last selects all three; nothing opens for it.
    await restRequestRow(page, 'One').click();
    await restRequestRow(page, 'Three').click({ modifiers: ['Shift'] });
    for (const name of ['One', 'Two', 'Three']) {
      await expect(treeItem(restRequestRow(page, name))).toHaveAttribute('aria-selected', 'true');
    }

    // The selection's menu moves them together.
    await chooseContextMenuItem(page, restRequestRow(page, 'Two'), 'Move to…');
    const dialog = page.getByTestId('move-request-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Move 3 requests');
    await page.getByTestId('move-request-target').selectOption({ label: ' Archive' });
    await page.getByTestId('move-request-submit').click();
    await expect(dialog).toBeHidden();

    await unfoldRow(folderRow(page, 'Archive'));
    const folderLevel = await treeItem(folderRow(page, 'Archive')).getAttribute('aria-level');
    for (const name of ['One', 'Two', 'Three']) {
      await expect(treeItem(restRequestRow(page, name))).toHaveAttribute(
        'aria-level',
        String(Number(folderLevel) + 1),
        { timeout: 20_000 },
      );
    }

    // F2 on the selected row starts an inline rename.
    await restRequestRow(page, 'Two').click();
    await page.keyboard.press('F2');
    const input = page.getByTestId('explorer-rename-input');
    await expect(input).toBeVisible({ timeout: 20_000 });
    await input.fill('Second');
    await input.press('Enter');
    await expect(restRequestRow(page, 'Second')).toBeVisible({ timeout: 20_000 });
    await expect(restRequestRow(page, 'Two')).toHaveCount(0);
  });
});
