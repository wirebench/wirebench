import { expect, test } from '@playwright/test';
import {
  freePort,
  startEchoServer,
  startSshFixture,
  type EchoServer,
  type SshFixture,
} from '@wirebench/ssh/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';
import { addPasswordHost, showSshNav, trustHostKey } from '../helpers/ssh-host.js';

let launched: LaunchedApp | undefined;
let fixture: SshFixture | undefined;
let echo: EchoServer | undefined;

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await fixture?.close();
    await echo?.close();
    launched = undefined;
    fixture = undefined;
    echo = undefined;
  }
});

test('the fixed SSH tab is named after the view it shows', async () => {
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Views');

  const views = [
    ['hosts', 'Hosts'],
    ['snippets', 'Snippets'],
    ['layouts', 'Layouts'],
    ['forwarding', 'Port forwarding'],
    ['keychain', 'Keychain'],
    ['known-hosts', 'Known hosts'],
  ] as const;
  for (const [entry, label] of views) {
    await showSshNav(page, entry);
    await expect(page.locator('#editor-tab-start')).toHaveText(label);
    // Every view opens on the same header, titled as the tab is.
    await expect(page.getByTestId('ssh-view-header').getByRole('heading')).toContainText(label);
  }

  // An empty view says what it is for and offers its first step.
  await showSshNav(page, 'layouts');
  await page
    .getByTestId('layouts-empty')
    .getByRole('button', { name: /Open a host/ })
    .click();
  await expect(page.locator('#editor-tab-start')).toHaveText('Hosts');
});

test('New rule… in the Port forwarding view adds a rule to the host picked, and it starts', async () => {
  test.setTimeout(180_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' }, allowForwardOut: true });
  echo = await startEchoServer();
  const port = await freePort();
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'New rule');
  await addPasswordHost(page, fixture, { name: 'db' });

  await showSshNav(page, 'forwarding');
  const empty = page.getByTestId('forwards-empty');
  await expect(empty).toBeVisible();
  await empty.getByRole('button', { name: /New rule/ }).click();

  const dialog = page.getByTestId('new-rule-dialog');
  // The only host is picked already.
  await expect(dialog.getByRole('combobox').locator('option')).toHaveText(['db']);
  await dialog.getByLabel('Id', { exact: true }).fill('pg');
  await dialog.getByLabel('Port', { exact: true }).fill(String(port));
  await dialog.getByLabel('Target (as the host sees it)').fill(`127.0.0.1:${String(echo.port)}`);
  await dialog.getByRole('button', { name: 'Add rule' }).click();
  await expect(dialog).toBeHidden();

  const row = page.getByTestId('forward-row').filter({ hasText: 'pg' });
  await expect(row).toContainText(String(port));
  await expect(page.getByTestId('ssh-view-count')).toHaveText('1');

  // The rule is the host's own: it starts like any other.
  await row.getByRole('button', { name: 'Start' }).click();
  await trustHostKey(page, fixture);
  await expect(row.getByLabel(/^running/)).toBeVisible({ timeout: 30_000 });
  await row.getByRole('button', { name: 'Stop' }).click();
  await expect(row.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 30_000 });
});
