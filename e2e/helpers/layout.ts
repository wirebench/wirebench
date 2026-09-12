import { expect, type Page } from '@playwright/test';

/** The pixel width of the sidebar panel, or `undefined` while it is collapsed (unmounted). */
export async function sidebarWidth(page: Page): Promise<number | undefined> {
  const panel = page.getByTestId('sidebar-panel');
  if ((await panel.count()) === 0) {
    return undefined;
  }
  return (await panel.boundingBox())?.width;
}

/** The pixel height of the console panel, or `undefined` while it is collapsed (unmounted). */
export async function consoleHeight(page: Page): Promise<number | undefined> {
  const panel = page.getByTestId('console-panel');
  if ((await panel.count()) === 0) {
    return undefined;
  }
  return (await panel.boundingBox())?.height;
}

/**
 * Drags a `panel-handle-*` separator by `(dx, dy)` pixels, from its own centre, via real mouse
 * events (Chromium reports these as `PointerEvent`s, which is what `PanelHandle` listens for).
 */
export async function dragHandle(page: Page, testId: string, dx: number, dy: number): Promise<void> {
  const handle = page.getByTestId(testId);
  const box = await handle.boundingBox();
  if (box === null) {
    throw new Error(`"${testId}" has no box to drag from`);
  }
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // A few intermediate steps so the drag is seen as a gesture rather than a single jump — closer
  // to what a real drag delivers, and exercises the handle's incremental-delta accumulation.
  await page.mouse.move(startX + dx / 2, startY + dy / 2, { steps: 4 });
  await page.mouse.move(startX + dx, startY + dy, { steps: 4 });
  await page.mouse.up();
}

/** Double-clicks a `panel-handle-*` separator at its own centre. */
export async function doubleClickHandle(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).dblclick();
}

/** Focuses a `panel-handle-*` separator and presses `key` `times` times (arrow-key resize). */
export async function stepHandle(page: Page, testId: string, key: string, times = 1): Promise<void> {
  const handle = page.getByTestId(testId);
  await handle.focus();
  for (let i = 0; i < times; i += 1) {
    await handle.press(key);
  }
}

/** Asserts the sidebar is showing (mounted, and the activity bar next to it). */
export async function expectSidebarVisible(page: Page): Promise<void> {
  await expect(page.getByTestId('sidebar-panel')).toBeVisible();
  await expect(page.getByTestId('activity-bar')).toBeVisible();
}

/** Asserts the sidebar is collapsed (unmounted) while the activity bar remains. */
export async function expectSidebarCollapsed(page: Page): Promise<void> {
  await expect(page.getByTestId('sidebar-panel')).toHaveCount(0);
  await expect(page.getByTestId('activity-bar')).toBeVisible();
}
