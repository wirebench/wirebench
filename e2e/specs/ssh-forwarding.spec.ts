import net from 'node:net';
import { expect, test, type Locator } from '@playwright/test';
import {
  freePort,
  startEchoServer,
  startSshFixture,
  type EchoServer,
  type SshFixture,
} from '@wirebench/ssh/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';
import { addPasswordHost, openAdvanced, trustHostKey } from '../helpers/ssh-host.js';

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

/** Adds a local rule in the host dialog's Port forwarding section. */
async function addLocalRule(
  dialog: Locator,
  rule: { readonly id: string; readonly port: number; readonly target: string; readonly autoStart?: boolean },
): Promise<void> {
  await dialog.getByRole('button', { name: 'Add rule' }).click();
  const form = dialog.getByTestId('forward-form').last();
  await form.getByLabel('Name', { exact: true }).fill(rule.id);
  await form.getByLabel('Port', { exact: true }).fill(String(rule.port));
  await form.getByLabel('Target (as the host sees it)').fill(rule.target);
  if (rule.autoStart === true) await form.getByRole('checkbox', { name: "Start with the host's terminals" }).check();
}

test('a local rule started from the view carries bytes; an autoStart rule follows a terminal', async () => {
  test.setTimeout(180_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' }, allowForwardOut: true });
  echo = await startEchoServer();
  const target = `127.0.0.1:${String(echo.port)}`;
  const pgPort = await freePort();
  const webPort = await freePort();
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Tunnels');

  await addPasswordHost(page, fixture, {
    name: 'db',
    beforeSave: async (dialog) => {
      await openAdvanced(dialog);
      await addLocalRule(dialog, { id: 'pg', port: pgPort, target });
      await addLocalRule(dialog, { id: 'web', port: webPort, target, autoStart: true });
    },
  });

  // Nothing runs yet, so the status bar has no forwarding item.
  const status = page.getByTestId('status-bar-forwards');
  await expect(status).toHaveCount(0);

  await page.getByTestId('ssh-nav-forwarding').click();
  const pg = page.getByTestId('forward-row').filter({ hasText: 'pg' });
  const web = page.getByTestId('forward-row').filter({ hasText: 'web' });
  await expect(pg).toContainText(String(pgPort));
  await expect(web).toContainText('auto');

  // Start by hand: the host key is new, so the trust prompt comes first and the start goes on after it.
  await pg.getByRole('button', { name: 'Start' }).click();
  await trustHostKey(page, fixture);
  // Stop shows while the rule is still starting; bytes go through once the row says it is running.
  await expect(pg.getByLabel(/^running/)).toBeVisible({ timeout: 30_000 });
  await expect(status).toHaveText('⇄ 1');

  // Bytes sent to the forwarded port come back from the echo server behind the host.
  expect(await roundTrip(pgPort, 'ping through the tunnel')).toBe('ping through the tunnel');

  await pg.getByRole('button', { name: 'Stop' }).click();
  await expect(pg.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 30_000 });
  await expect(status).toHaveCount(0);

  // A terminal to the host starts its autoStart rule; closing the terminal stops it again.
  await page.getByTestId('ssh-nav-hosts').click();
  await page.getByTestId('host-row-db').dblclick();
  await expect(page.getByTestId('editor-area').getByLabel('connected', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(status).toHaveText('⇄ 1', { timeout: 30_000 });
  await page.getByTestId('ssh-nav-forwarding').click();
  await expect(web.getByLabel(/^running/)).toBeVisible({ timeout: 30_000 });
  expect(await roundTrip(webPort, 'auto')).toBe('auto');
  await expect(pg.getByRole('button', { name: 'Start' })).toBeVisible();

  // The view shows in the area's first tab; the terminal's own tab is the one named after the host.
  await page.getByRole('tab', { name: /db/ }).getByTestId('editor-tab-close').click();
  // A tab with live sessions asks once before ending them (S53).
  await expect(page.getByTestId('live-close')).toBeVisible();
  await page.getByTestId('live-close-confirm').click();
  await expect(web.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 30_000 });
  await expect(status).toHaveCount(0);
});
