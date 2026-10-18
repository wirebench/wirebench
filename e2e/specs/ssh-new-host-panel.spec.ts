import { expect, test, type Locator } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';
import { fillNewHost, showSshNav } from '../helpers/ssh-host.js';

/*
 * New host in the details panel (#674): the form opens beside the hosts rather than over them, a draft card
 * stands where Save will put the host, and leaving a form with typing in it asks first.
 */

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

/** Sizes the window's content area, as a user dragging its frame would. */
async function contentSize(app: LaunchedApp, width: number, height: number): Promise<void> {
  await app.app.evaluate(
    async ({ BrowserWindow }, size) => {
      const [window] = BrowserWindow.getAllWindows();
      window?.setContentSize(size.width, size.height);
      await new Promise((resolve) => setTimeout(resolve, 250));
    },
    { width, height },
  );
}

async function box(of: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const found = await of.boundingBox();
  if (found === null) throw new Error('not laid out');
  return found;
}

test('New host opens in the panel with a draft card, at 1024×700 (#674)', async () => {
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Draft');
  await contentSize(launched, 1024, 700);
  await showSshNav(page, 'hosts');

  // The empty state's Add host opens the form beside a draft card, not a modal over the hosts.
  await page.getByTestId('hosts-empty').getByRole('button', { name: 'Add host' }).click();
  const form = page.getByTestId('host-dialog');
  await expect(form).toBeVisible();
  await expect(page.getByTestId('slide-over')).toHaveAttribute('aria-label', 'New host');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const draft = page.getByTestId('host-draft-card');
  await expect(draft).toContainText('New host');

  await fillNewHost(form, { name: 'web-2', port: 2222, user: 'deploy', password: 'pw' });
  await expect(draft).toContainText('web-2');
  await expect(draft).toContainText('deploy@127.0.0.1:2222');

  // The draft card and the panel sit side by side, both whole.
  const card = await box(draft);
  const panel = await box(page.getByTestId('slide-over'));
  expect(card.x + card.width).toBeLessThanOrEqual(panel.x + 1);
  expect(card.width).toBeGreaterThan(150);
  expect(panel.x + panel.width).toBeLessThanOrEqual(1024 + 1);

  // Escape with typing asks first; Cancel keeps the form as it was.
  await form.getByLabel('Name', { exact: true }).press('Escape');
  const ask = page.getByTestId('host-discard');
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toBeHidden();
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('web-2');

  // Save turns the draft into the real card, and the panel goes back to how it was (put away).
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toBeHidden();
  await expect(draft).toHaveCount(0);
  await expect(page.getByTestId('host-row-web-2')).toBeVisible();
  await expect(page.getByTestId('slide-over')).toBeHidden();

  // Duplicate opens the form filled in from the host; Cancel on it, untouched, drops the draft at once.
  await page.getByTestId('host-row-web-2').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('web-2 copy');
  await expect(form.getByLabel('Address', { exact: true })).toHaveValue('127.0.0.1');
  await expect(draft).toContainText('web-2 copy');
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toBeHidden();
  await expect(draft).toHaveCount(0);
  await expect(page.getByTestId('host-row-web-2-copy')).toHaveCount(0);
});
