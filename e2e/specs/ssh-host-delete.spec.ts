import { expect, test, type Locator } from '@playwright/test';
import { startSshFixture, type SshFixture } from '@wirebench/ssh/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';
import { addPasswordHost, showSshNav } from '../helpers/ssh-host.js';

let launched: LaunchedApp | undefined;
let fixture: SshFixture | undefined;

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await fixture?.close();
    launched = undefined;
    fixture = undefined;
  }
});

/**
 * Whether `dialog` is what the window shows at a point inside it: its middle, or `x` across at its middle
 * height. Something drawn over it (a pane's connection screen, a split divider) would be hit instead. A modal
 * dialog turns pointer events off outside itself, which hit-testing skips, so they are on for the check.
 */
async function onTop(dialog: Locator, x?: number): Promise<boolean> {
  return dialog.evaluate((element, across) => {
    const style = document.createElement('style');
    style.textContent = '* { pointer-events: auto !important; }';
    document.head.append(style);
    try {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(across ?? rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit !== null && element.contains(hit);
    } finally {
      style.remove();
    }
  }, x);
}

test('dialogs draw over the panes, and deleting a host asks first and closes its sessions', async () => {
  test.setTimeout(180_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' } });
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Delete');
  await addPasswordHost(page, fixture, { name: 'web' });

  // The trust prompt opens over the pane's connection screen, and must be what shows there.
  await page.getByTestId('host-row-web').dblclick();
  const trust = page.getByTestId('trust-dialog');
  await expect(trust).toBeVisible({ timeout: 30_000 });
  expect(await onTop(trust)).toBe(true);
  await trust.getByRole('button', { name: 'Trust and connect' }).click();
  await expect(trust).toBeHidden();
  await expect(page.getByTestId('editor-area').getByLabel('connected', { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // Split right on the same host: two sessions, and a divider down the middle of the tab.
  await page.getByRole('button', { name: 'Split right' }).click();
  await expect(page.getByTestId('ssh-pane-host-input')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ssh-pane-header').getByLabel('connected', { exact: true })).toHaveCount(2, {
    timeout: 30_000,
  });

  // The Save layout dialog sits across the divider; the divider must not draw through it.
  await page.getByRole('button', { name: 'Save layout…' }).click();
  const saveLayout = page.getByTestId('layout-name-dialog');
  await expect(saveLayout).toBeVisible();
  const divider = await page.getByTestId('ssh-pane-divider').boundingBox();
  expect(divider).not.toBeNull();
  const dialogBox = await saveLayout.boundingBox();
  expect(dialogBox).not.toBeNull();
  if (divider !== null && dialogBox !== null) {
    const across = divider.x + divider.width / 2;
    expect(across).toBeGreaterThan(dialogBox.x);
    expect(across).toBeLessThan(dialogBox.x + dialogBox.width);
    expect(await onTop(saveLayout, across)).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(saveLayout).toBeHidden();

  // Delete asks first and names the sessions that will close; Cancel keeps everything.
  await showSshNav(page, 'hosts');
  const row = page.getByTestId('host-row-web');
  await row.click({ button: 'right' });
  const deleteItem = page.getByRole('menuitem', { name: 'Delete' });
  await expect(deleteItem).toBeVisible();
  await deleteItem.click();
  const confirm = page.getByTestId('host-delete-dialog');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('Delete web?');
  await expect(confirm).toContainText('2 open sessions will close.');
  expect(await onTop(confirm)).toBe(true);
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  await expect(row).toBeVisible();
  await expect(page.getByRole('tab', { name: /web/ })).toHaveCount(1);

  // Confirmed, the host goes and its terminal tab closes with both panes.
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(confirm).toBeVisible();
  await page.getByTestId('host-delete-confirm').click();
  await expect(confirm).toBeHidden();
  await expect(row).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /web/ })).toHaveCount(0);
  await expect(page.getByTestId('ssh-terminal')).toHaveCount(0);
});
