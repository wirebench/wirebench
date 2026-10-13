import { expect, test, type Page } from '@playwright/test';
import { startSshFixture, type SshFixture } from '@wirebench/ssh/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';
import { addPasswordHost, trustHostKey } from '../helpers/ssh-host.js';

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

/** Waits until `count` panes of the open terminal tab say their session is open. */
async function expectConnectedPanes(page: Page, count: number): Promise<void> {
  await expect(page.getByTestId('ssh-pane-header').getByLabel('connected', { exact: true })).toHaveCount(count, {
    timeout: 30_000,
  });
}

/** Clicks into pane `index` of the open terminal tab and types `line` and Enter. */
async function typeInPane(page: Page, index: number, line: string): Promise<void> {
  await page.getByTestId('ssh-terminal').nth(index).click();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

test('split a terminal, save and reopen the layout, broadcast to both panes', async () => {
  test.setTimeout(180_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' } });
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Panes');
  await addPasswordHost(page, fixture, { name: 'box' });

  await page.getByTestId('host-row-box').dblclick();
  await trustHostKey(page, fixture);
  await expect(page.getByTestId('editor-area').getByLabel('connected', { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // Split right: the host picker starts on the current pane's host, so Enter connects the new pane to it.
  await page.getByRole('button', { name: 'Split right' }).click();
  await expect(page.getByTestId('ssh-pane-host-input')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ssh-pane')).toHaveCount(2);
  await expectConnectedPanes(page, 2);

  // The fixture's shell echoes what each pane is sent, so each pane shows only its own line.
  const terminals = page.getByTestId('ssh-terminal');
  await typeInPane(page, 0, 'left pane');
  await expect(terminals.nth(0)).toContainText('left pane', { timeout: 30_000 });
  await typeInPane(page, 1, 'right pane');
  await expect(terminals.nth(1)).toContainText('right pane', { timeout: 30_000 });
  await expect(terminals.nth(0)).not.toContainText('right pane');

  await page.getByRole('button', { name: 'Save layout…' }).click();
  const name = page.getByTestId('layout-name-dialog');
  await expect(name).toBeVisible();
  await name.getByLabel('Layout name').fill('Two');
  await name.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(name).toBeHidden();

  // Saved, the tab takes the layout's name. Closing it ends both sessions.
  const tab = page.getByRole('tab', { name: /Two/ });
  await expect(tab).toBeVisible();
  await tab.getByTestId('editor-tab-close').click();
  await expect(page.getByTestId('ssh-pane')).toHaveCount(0);

  await page.getByTestId('ssh-nav-layouts').click();
  const row = page.getByTestId('layout-row').filter({ hasText: 'Two' });
  await expect(row).toContainText('2 panes');
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByTestId('ssh-pane')).toHaveCount(2, { timeout: 30_000 });
  await expectConnectedPanes(page, 2);

  // Broadcast: on with every pane ticked, a banner that cannot be missed, one line reaching both panes.
  await page.getByRole('button', { name: 'Broadcast', exact: true }).click();
  const banner = page.getByTestId('ssh-broadcast-banner');
  await expect(banner).toContainText('Broadcasting to 2 of 2 panes');
  await expect(page.locator('[data-testid="ssh-pane"][data-broadcast="true"]')).toHaveCount(2);
  await expect(page.getByRole('tab', { name: /Two/ }).getByLabel('Broadcasting')).toBeVisible();
  await typeInPane(page, 0, 'echo hi');
  await expect(terminals.nth(0)).toContainText('echo hi', { timeout: 30_000 });
  await expect(terminals.nth(1)).toContainText('echo hi', { timeout: 30_000 });

  await banner.getByRole('button', { name: 'Stop' }).click();
  await expect(banner).toBeHidden();
  await expect(page.locator('[data-testid="ssh-pane"][data-broadcast="true"]')).toHaveCount(0);
});
