import { expect, test, type Locator, type Page } from '@playwright/test';
import { startSshFixture, type SshFixture } from '@wirebench/ssh/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';
import { addPasswordHost, openAdvanced, showSshNav } from '../helpers/ssh-host.js';

/*
 * Every SSH slide-over at 280–400px of panel width in a 1024×700 window (#591): the panel never scrolls
 * sideways, so a row wider than it would be clipped. Nothing in it may be laid out past its edges.
 */

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

const WIDTHS = [280, 320, 400] as const;

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

/** Steps the open slide-over to `width` from its handle's keys (16px a press; 280 is its narrowest). */
async function panelWidth(page: Page, width: number): Promise<void> {
  const handle = page.getByTestId('panel-handle-slide-over');
  for (let i = 0; i < 40; i += 1) {
    const now = Number(await handle.getAttribute('aria-valuenow'));
    if (Math.abs(now - width) < 16 || (width <= 280 && now <= 280)) break;
    await handle.press(now > width ? 'ArrowRight' : 'ArrowLeft');
  }
  await page.waitForTimeout(100);
}

/**
 * The elements in the slide-over's body laid out past its left edge or its right one (the scrollbar's
 * edge), which the body, hidden sideways, clips. The code editor's own layers are left out: it clips and
 * scrolls its text itself.
 */
async function overflowing(page: Page): Promise<string[]> {
  return page.getByTestId('slide-over-body').evaluate((body) => {
    const outer = body.getBoundingClientRect();
    const left = outer.left + body.clientLeft;
    const right = left + body.clientWidth;
    return Array.from(body.querySelectorAll('*'))
      .filter((el): el is HTMLElement => el instanceof HTMLElement)
      .filter((el) => el.closest('.monaco-editor') === null || el.classList.contains('monaco-editor'))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        return r.right > right + 1 || r.left < left - 1;
      })
      .map((el) => {
        const name = el.dataset['testid'] ?? el.getAttribute('aria-label') ?? el.textContent.trim().slice(0, 30);
        const r = el.getBoundingClientRect();
        return `${el.tagName.toLowerCase()} "${name}" ${String(Math.round(r.left))}–${String(Math.round(r.right))} of ${String(Math.round(left))}–${String(Math.round(right))}`;
      });
  });
}

/** Checks the open slide-over at each width. */
async function fitsAtEveryWidth(page: Page, what: string): Promise<void> {
  for (const width of WIDTHS) {
    await panelWidth(page, width);
    expect.soft(await overflowing(page), `${what} at ${String(width)}px`).toEqual([]);
  }
}

/** Whether `of` lies inside the slide-over's body, edge to edge. */
async function inPanel(page: Page, of: Locator): Promise<void> {
  const panel = await page.getByTestId('slide-over-body').boundingBox();
  const box = await of.boundingBox();
  if (panel === null || box === null) throw new Error('not laid out');
  expect(box.x).toBeGreaterThanOrEqual(panel.x);
  expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
}

test('no SSH slide-over row is wider than the panel at 280–400px (#591)', async () => {
  test.setTimeout(180_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' } });
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Narrow');
  await addPasswordHost(page, fixture, {
    name: 'box',
    beforeSave: async (dialog) => {
      await openAdvanced(dialog);
      await dialog.getByRole('button', { name: 'Add rule' }).click();
      const form = dialog.getByTestId('forward-form').last();
      await form.getByLabel('Name', { exact: true }).fill('postgres-primary');
      await form.getByLabel('Port', { exact: true }).fill('15432');
      await form.getByLabel('Target (as the host sees it)').fill('db.internal.example:5432');
    },
  });
  await contentSize(launched, 1024, 700);

  // Host details, then the host's form in the same panel: password, then key sign-in.
  await page.getByTestId('host-row-box').click();
  if (!(await page.getByTestId('host-details').isVisible())) await page.getByTestId('rail-host-details').click();
  await expect(page.getByTestId('host-details')).toBeVisible();
  await fitsAtEveryWidth(page, 'Host details');

  await page.getByTestId('host-details').getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByTestId('host-edit');
  const password = edit.locator('input[type="password"]').first();
  await expect.soft(password).toHaveAttribute('placeholder', '•••• stored · type to replace');
  await expect.soft(edit.getByText('Stored as the secret box_password.')).toBeVisible();
  await openAdvanced(edit);
  await fitsAtEveryWidth(page, 'Edit host (password)');
  await edit.getByRole('radio', { name: 'Key', exact: true }).check();
  await expect(edit.getByLabel('Passphrase secret', { exact: true })).toBeVisible();
  await fitsAtEveryWidth(page, 'Edit host (key)');
  await edit.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('host-discard')).toBeVisible();
  await page.getByTestId('host-discard').getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByTestId('host-details')).toBeVisible();

  // New host in the same panel, for each protocol, with Advanced open (#674).
  await page.getByRole('button', { name: 'New host', exact: true }).click();
  const form = page.getByTestId('host-dialog');
  await expect(form).toBeVisible();
  await form.getByLabel('Name', { exact: true }).fill('a-new-host-with-a-long-name');
  await openAdvanced(form);
  const protocolSelect = form.getByRole('combobox', { name: 'Protocol' });
  const protocols = await protocolSelect
    .locator('option')
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  for (const protocol of protocols) {
    await protocolSelect.selectOption(protocol);
    await fitsAtEveryWidth(page, `New host (${protocol === '' ? 'ssh' : protocol})`);
  }
  await form.getByRole('button', { name: 'Cancel' }).click();
  await page.getByTestId('host-discard').getByRole('button', { name: 'Discard' }).click();
  await expect(form).toBeHidden();

  // A new snippet with a variable: every field and the remove button stay in the panel.
  await showSshNav(page, 'snippets');
  await page.getByTestId('ssh-view-header').getByRole('button', { name: 'New snippet', exact: true }).click();
  const snippet = page.getByTestId('snippet-editor');
  await expect(snippet).toBeVisible();
  await snippet.getByRole('button', { name: 'Add variable' }).click();
  await snippet.getByLabel('Variable name', { exact: true }).fill('service');
  await fitsAtEveryWidth(page, 'Snippet');
  await panelWidth(page, 280);
  await snippet.getByLabel('Default of service', { exact: true }).fill('api');
  await inPanel(page, snippet.getByLabel('Default of service', { exact: true }));
  await inPanel(page, snippet.getByRole('button', { name: 'Remove service' }));
  await snippet.getByRole('button', { name: 'Remove service' }).click();
  await expect(snippet.getByLabel('Variable name', { exact: true })).toHaveCount(0);
  await page.getByTestId('slide-over-close').click();

  // A forwarding rule's details.
  await showSshNav(page, 'forwarding');
  await page.getByTestId('forward-row').filter({ hasText: 'postgres-primary' }).getByTestId('forward-meta').click();
  await expect(page.getByTestId('forward-details')).toBeVisible();
  await fitsAtEveryWidth(page, 'Forward details');
});
