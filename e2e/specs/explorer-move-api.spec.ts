/**
 * An API leaves its project (#701): dragged onto another project's row, or sent there with
 * **Move to project…**, and reordered among its project's APIs by a drag. Its requests open from the
 * new place, and Undo puts it back.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { apiRow, chooseContextMenuItem, createApi, createRestRequest, restRequestRow } from '../helpers/rest.js';

/** The explorer's rows top to bottom, by label: where a row sits says which project it is under. */
async function rowLabels(page: Page): Promise<string[]> {
  return await page.locator('[data-tree-id]').evaluateAll((rows) => rows.map((row) => (row.textContent ?? '').trim()));
}

/** Waits until `first`'s row sits above `second`'s. */
async function expectAbove(page: Page, first: string, second: string, timeout = 20_000): Promise<void> {
  await expect(async () => {
    const labels = await rowLabels(page);
    const above = labels.findIndex((text) => text.startsWith(first));
    const below = labels.findIndex((text) => text.startsWith(second));
    expect(above).toBeGreaterThanOrEqual(0);
    expect(below).toBeGreaterThan(above);
  }).toPass({ timeout });
}

/**
 * Drags `source` onto the middle of `target` the way a hand does: press, a few moves to get the drag
 * going, then small moves to the drop point, so the tree's HTML5 drag sees enough `dragover` events to
 * settle on a drop. The target is measured only once the drag has started, since rows can move. The
 * drag then rests on the drop point before letting go: the tree drops where its last hover was, and
 * without the pause that can still be the bottom edge of the row above ("after it", not "into").
 *
 * The row is selected with a click first, and the press waits for it to render again: under the
 * test's emulated drag, a drag that starts on a row before its re-render has settled (after a drop,
 * or after the click itself) can fail to reach the tree, so callers repeat the gesture until it lands.
 */
async function dragRow(page: Page, source: Locator, target: Locator): Promise<void> {
  await source.click();
  // The click opens the API's tab and re-renders the row; the press waits for that to finish.
  await page.waitForTimeout(500);
  const from = await source.boundingBox();
  if (from === null) throw new Error('The row to drag is not on screen');
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 4, startY + 4, { steps: 4 });
  const to = await target.boundingBox();
  if (to === null) throw new Error('The drop row is not on screen');
  const endX = to.x + to.width / 2;
  const endY = to.y + to.height / 2;
  await page.mouse.move(endX, endY, { steps: 20 });
  // Dwell on the drop point so the tree's last hover is this row's middle, not the row it passed over.
  for (const dy of [2, -2, 0]) {
    await page.waitForTimeout(100);
    await page.mouse.move(endX, endY + dy, { steps: 2 });
  }
  await page.waitForTimeout(100);
  await page.mouse.up();
}

function projectRow(page: Page, name: string) {
  return page.getByTestId('explorer-project-row').filter({ hasText: name });
}

test.describe('Explorer: move an API to another project', () => {
  let launched: LaunchedApp | undefined;

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
  });

  test('a drag reorders APIs, a drop on another project moves one there, and its requests open from it', async () => {
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page);
    await createProject(page, 'Alpha');
    await createApi(page, 'Pets', 'http://localhost:9');
    await createRestRequest(page, 'Pets', 'List pets');
    await createApi(page, 'Orders', 'http://localhost:9');
    await expectAbove(page, 'Pets', 'Orders');

    // --- reorder: Orders dropped on its own project's row goes to the top, before Pets ------
    // Each drag is repeated until it lands (see `dragRow`); dropping the same row there again changes nothing.
    await expect(async () => {
      await dragRow(page, apiRow(page, 'Orders'), projectRow(page, 'Alpha'));
      await expectAbove(page, 'Orders', 'Pets', 3_000);
    }).toPass({ timeout: 60_000 });

    // --- move by drag: Pets dropped on Beta's row goes there, ids and all ------------------
    // Beta is the last project, so a row below it is under it.
    await createProject(page, 'Beta');
    await expect(async () => {
      await dragRow(page, apiRow(page, 'Pets'), projectRow(page, 'Beta'));
      await expect(page.getByTestId('toast-viewport')).toContainText('Moved to “Beta”', { timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
    await expectAbove(page, 'Beta', 'Pets');
    // The tab opened on the request before the move is still the request's.
    await expect(page.getByRole('tab', { name: /List pets/ })).toBeVisible();

    // Its request opens from the new place.
    await apiRow(page, 'Pets').click();
    await restRequestRow(page, 'List pets').click();
    await expect(page.getByTestId('rest-editor')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('rest-breadcrumb-name')).toHaveText('List pets');

    // --- Undo puts it back in Alpha ---------------------------------------------------------
    await page.getByTestId('toast-action').filter({ hasText: 'Undo' }).click();
    await expectAbove(page, 'Pets', 'Beta');

    // --- move by menu: Orders goes to Beta through Move to project… -------------------------
    await chooseContextMenuItem(page, apiRow(page, 'Orders'), 'Move to project…');
    await expect(page.getByTestId('move-api-dialog')).toBeVisible();
    await expect(page.getByTestId('move-api-plan')).toBeAttached({ timeout: 20_000 });
    await page.getByTestId('move-api-submit').click();
    await expectAbove(page, 'Beta', 'Orders');
  });
});
