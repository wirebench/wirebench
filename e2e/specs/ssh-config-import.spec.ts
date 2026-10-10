import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startSshFixture, type SshFixture } from '@wirebench/ssh/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';

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

test('import a host from an SSH config, store its key, connect with it', async () => {
  test.setTimeout(180_000);
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  fixture = await startSshFixture({
    password: { user: 'tester', password: 'not-used' },
    key: { user: 'tester', privateKey },
  });
  const dir = mkdtempSync(join(tmpdir(), 'wb-ssh-config-'));
  const keyPath = join(dir, 'id_test');
  writeFileSync(keyPath, privateKey, { mode: 0o600 });
  const configPath = join(dir, 'config');
  writeFileSync(
    configPath,
    [
      'Host box',
      '  HostName 127.0.0.1',
      `  Port ${String(fixture.port)}`,
      `  IdentityFile "${keyPath}"`,
      '  LocalForward 8080 localhost:80',
      'Host *',
      '  User tester',
      '',
    ].join('\n'),
  );

  launched = await launchApp({ extraEnv: { WIREBENCH_E2E_FILE_DIALOG_PATH: configPath } });
  const page = launched.window;
  await createWorkspace(page, 'Imported');

  await page.keyboard.press(`${MOD}+Shift+P`);
  const input = page.getByTestId('command-palette-input');
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.fill('Import from SSH Config');
  await page
    .getByRole('option', { name: /Import from SSH Config/ })
    .first()
    .click();

  const dialog = page.getByTestId('ssh-import-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Choose a file…' }).click();
  const table = dialog.getByRole('table', { name: 'Hosts to import' });
  await expect(table).toContainText('box', { timeout: 20_000 });
  await expect(dialog.getByRole('region', { name: 'Not imported' })).toContainText('localforward');

  // The key is read only because this row asks for it.
  await dialog.getByRole('radio', { name: /Store as workspace secret/ }).check();
  await dialog.getByRole('button', { name: 'Import 1 host' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Imported 1 host into SSH config; stored ssh_key_id_test/)).toBeVisible();

  await page.getByTestId('host-row-box').dblclick();
  const trust = page.getByTestId('trust-dialog');
  await expect(trust).toBeVisible({ timeout: 30_000 });
  await trust.getByRole('button', { name: 'Trust and connect' }).click();
  const terminal = page.getByTestId('ssh-terminal');
  await expect(page.getByTestId('editor-area').getByLabel('connected', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await terminal.click();
  await page.keyboard.type('echo keyed');
  await page.keyboard.press('Enter');
  await expect(terminal).toContainText('echo keyed', { timeout: 30_000 });
});
