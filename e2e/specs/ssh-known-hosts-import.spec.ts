import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startSshFixture, type SshFixture } from '@wirebench/ssh/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';
import { showSshNav } from '../helpers/ssh-host.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

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

/** A `HashKnownHosts` name: `|1|salt|HMAC-SHA1(salt, name)`. */
function hashed(name: string): string {
  const salt = randomBytes(20);
  return `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(name).digest('base64')}`;
}

async function runCommand(page: LaunchedApp['window'], label: string): Promise<void> {
  await page.keyboard.press(`${MOD}+Shift+P`);
  const input = page.getByTestId('command-palette-input');
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.fill(label);
  await page
    .getByRole('option', { name: new RegExp(label) })
    .first()
    .click();
}

test('trust a host key from a hashed known_hosts line', async () => {
  test.setTimeout(180_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'not-used' } });
  const dir = mkdtempSync(join(tmpdir(), 'wb-known-hosts-'));
  const configPath = join(dir, 'config');
  writeFileSync(configPath, `Host box\n  HostName 127.0.0.1\n  Port ${String(fixture.port)}\n  User tester\n`);
  const knownHostsPath = join(dir, 'known_hosts');
  writeFileSync(
    knownHostsPath,
    [
      '# a comment',
      `${hashed(`[127.0.0.1]:${String(fixture.port)}`)} ${fixture.hostPublicKey}`,
      `@cert-authority *.example.com ${fixture.hostPublicKey}`,
      '',
    ].join('\n'),
  );

  launched = await launchApp({ extraEnv: { WIREBENCH_E2E_FILE_DIALOG_PATH: configPath } });
  const page = launched.window;
  await createWorkspace(page, 'Known hosts');

  await runCommand(page, 'Import Hosts');
  const configDialog = page.getByTestId('ssh-import-dialog');
  await configDialog.getByRole('button', { name: 'Choose a file…' }).click();
  await configDialog.getByRole('button', { name: 'Import 1 host' }).click();
  await expect(configDialog).toBeHidden();

  // The picker answers with the known_hosts file from here on.
  await launched.app.evaluate((_electron, path) => {
    process.env['WIREBENCH_E2E_FILE_DIALOG_PATH'] = path;
  }, knownHostsPath);
  await runCommand(page, 'Import Known Hosts');
  const dialog = page.getByTestId('known-hosts-import-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Choose a file…' }).click();
  const table = dialog.getByRole('table', { name: 'Keys to trust' });
  await expect(table).toContainText(`127.0.0.1:${String(fixture.port)}`, { timeout: 20_000 });
  await expect(table).toContainText(fixture.hostKey.fingerprint);
  await expect(dialog.getByRole('region', { name: 'Not imported' })).toContainText('@cert-authority');
  await dialog.getByRole('button', { name: 'Trust 1 key' }).click();
  await expect(dialog).toBeHidden();

  const row = page.getByTestId(`known-host-127.0.0.1:${String(fixture.port)}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(fixture.hostKey.fingerprint);
});

test('add a host that is not saved from a plain known_hosts line, and trust its key', async () => {
  test.setTimeout(180_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'not-used' } });
  const dir = mkdtempSync(join(tmpdir(), 'wb-known-hosts-'));
  const knownHostsPath = join(dir, 'known_hosts');
  const server = `127.0.0.1:${String(fixture.port)}`;
  writeFileSync(
    knownHostsPath,
    [
      `[127.0.0.1]:${String(fixture.port)} ${fixture.hostPublicKey}`,
      `${hashed('hidden.example.com')} ${fixture.hostPublicKey}`,
      '',
    ].join('\n'),
  );

  launched = await launchApp({ extraEnv: { WIREBENCH_E2E_FILE_DIALOG_PATH: knownHostsPath } });
  const page = launched.window;
  await createWorkspace(page, 'Known hosts add');

  await runCommand(page, 'Import Known Hosts');
  const dialog = page.getByTestId('known-hosts-import-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Choose a file…' }).click();
  const unsaved = dialog.getByRole('region', { name: 'Not in hosts.yaml' });
  await expect(unsaved).toContainText('127.0.0.1', { timeout: 20_000 });
  await expect(unsaved).toContainText(fixture.hostKey.fingerprint);
  // The hashed line names no host to add: it stays not imported.
  await expect(dialog.getByRole('region', { name: 'Not imported' })).toContainText('(line 2)');
  await dialog.getByRole('checkbox', { name: `Add ${server}` }).check();
  await dialog.getByRole('button', { name: 'Add 1 host and trust its keys' }).click();
  await expect(dialog).toBeHidden();

  const key = page.getByTestId(`known-host-${server}`);
  await expect(key).toBeVisible();
  await expect(key).toContainText(fixture.hostKey.fingerprint);

  await showSshNav(page, 'hosts');
  const host = page.getByTestId('host-row-127-0-0-1');
  await expect(host).toBeVisible();
  await expect(host).toContainText('needs user');
});
