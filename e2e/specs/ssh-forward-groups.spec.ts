import net from 'node:net';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  freePort,
  startEchoServer,
  startSshFixture,
  type EchoServer,
  type SshFixture,
} from '@wirebench/ssh/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';
import { addPasswordHost, openAdvanced, showSshNav, trustHostKey } from '../helpers/ssh-host.js';

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

/** Sends `text` to 127.0.0.1:`port` and resolves with what comes back once as many bytes have. */
async function roundTrip(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let received = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(text));
    socket.on('data', (chunk: string) => {
      received += chunk;
      if (received.length >= text.length) {
        socket.end();
        resolve(received);
      }
    });
    socket.on('error', reject);
  });
}

/** Adds a host for the fixture with one local rule to the echo server. */
async function addHostWithRule(page: Page, name: string, rule: string, port: number, target: string): Promise<void> {
  if (fixture === undefined) throw new Error('no fixture');
  await addPasswordHost(page, fixture, {
    name,
    beforeSave: async (dialog: Locator) => {
      await openAdvanced(dialog);
      await dialog.getByRole('button', { name: 'Add rule' }).click();
      const form = dialog.getByTestId('forward-form').last();
      await form.getByLabel('Name', { exact: true }).fill(rule);
      await form.getByLabel('Port', { exact: true }).fill(String(port));
      await form.getByLabel('Target (as the host sees it)').fill(target);
    },
  });
}

/**
 * Moves a rule into a forwarding group from its row's ⋯ menu. The submenu is driven from the keyboard: a
 * pointer crossing from the trigger to the item can close it on the way.
 */
async function moveToGroup(page: Page, row: Locator, rule: string, group: string): Promise<void> {
  await row.getByRole('button', { name: `More actions for ${rule}` }).click();
  await page.getByRole('menuitem', { name: 'Move to group' }).focus();
  await page.keyboard.press('ArrowRight');
  const item = page.getByRole('menuitem', { name: group, exact: true });
  await expect(item).toBeVisible();
  await item.press('Enter');
}

test('a forwarding group of two rules on two hosts starts and stops together (#583)', async () => {
  test.setTimeout(180_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' }, allowForwardOut: true });
  echo = await startEchoServer();
  const target = `127.0.0.1:${String(echo.port)}`;
  const pgPort = await freePort();
  const cachePort = await freePort();
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Groups');

  // Two hosts, each with its own rule: the group spans both.
  await addHostWithRule(page, 'db', 'pg', pgPort, target);
  await addHostWithRule(page, 'cache', 'redis', cachePort, target);

  await showSshNav(page, 'forwarding');
  const pg = page.getByTestId('forward-row').filter({ hasText: 'pg' });
  const redis = page.getByTestId('forward-row').filter({ hasText: 'redis' });

  // Both hosts are the one fixture: trusting its key once, on a single start, covers both.
  await pg.getByRole('button', { name: 'Start' }).click();
  await trustHostKey(page, fixture);
  await expect(pg.getByLabel(/^running/)).toBeVisible({ timeout: 30_000 });
  await pg.getByRole('button', { name: 'Stop' }).click();
  await expect(pg.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 30_000 });

  // A new group starts empty and says how to fill it.
  await page
    .getByTestId('ssh-view-header')
    .getByRole('button', { name: /New group/ })
    .click();
  const dialog = page.getByTestId('forward-group-dialog');
  await dialog.getByLabel('Group name').fill('Dev');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toBeHidden();
  const dev = page.locator('[data-testid="forward-group"][data-group="dev"]');
  await expect(dev).toContainText('No rules yet');

  await moveToGroup(page, pg, 'pg', 'Dev');
  await expect(dev.getByTestId('forward-row')).toHaveCount(1);
  // The second rule is dragged onto the group instead.
  await redis.dragTo(dev);
  await expect(dev.getByTestId('forward-row')).toHaveCount(2);
  const status = dev.getByTestId('forward-group-status');
  await expect(status).toHaveText('0 of 2 running');

  // Start group connects to each host and starts both rules.
  await dev.getByRole('button', { name: 'Start group' }).click();
  await expect(status).toHaveText('2 of 2 running', { timeout: 30_000 });
  await expect(pg.getByLabel(/^running/)).toBeVisible();
  await expect(redis.getByLabel(/^running/)).toBeVisible();
  expect(await roundTrip(pgPort, 'through db')).toBe('through db');
  expect(await roundTrip(cachePort, 'through cache')).toBe('through cache');

  // Stop group stops both.
  await dev.getByRole('button', { name: 'Stop group' }).click();
  await expect(status).toHaveText('0 of 2 running', { timeout: 30_000 });
  await expect(pg.getByRole('button', { name: 'Start' })).toBeVisible();
  await expect(redis.getByRole('button', { name: 'Start' })).toBeVisible();

  // Picking a row opens its details on the right; the rail offers them in place of the host details.
  await pg.locator('[data-testid="forward-meta"]').click();
  const details = page.getByTestId('forward-details');
  await expect(details.getByRole('heading', { name: 'pg' })).toBeVisible();
  await expect(details.getByRole('combobox', { name: 'Forwarding group' })).toHaveValue('dev');
  await expect(page.getByTestId('rail-forward-details')).toHaveAttribute('aria-expanded', 'true');
  await page.getByTestId('rail-forward-details').click();
  await expect(details).toBeHidden();
});
