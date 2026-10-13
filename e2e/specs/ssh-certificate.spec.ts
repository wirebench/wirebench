import { expect, test } from '@playwright/test';
import { certFixture, sshdPath, startOpenSshServer, type OpenSshServer } from '@wirebench/ssh/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';
import { showSshNav } from '../helpers/ssh-host.js';

let launched: LaunchedApp | undefined;
let server: OpenSshServer | undefined;

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await server?.close();
    launched = undefined;
    server = undefined;
  }
});

// A real OpenSSH server that trusts the test CA and lets in only certificates it signed: nothing else
// (no password, no authorized key) would sign in.
test('attach a certificate to a keychain key and sign in with it', async () => {
  test.skip(sshdPath() === undefined, 'needs an OpenSSH sshd on this machine');
  test.setTimeout(180_000);
  server = await startOpenSshServer();
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Certs');

  // The key as a keychain secret, then its certificate pasted onto it.
  await showSshNav(page, 'keychain');
  await page.getByRole('button', { name: 'New secret' }).click();
  const form = page.getByRole('form', { name: 'Store a secret' });
  await form.getByLabel('Secret name', { exact: true }).fill('ci_key');
  await form.getByLabel('Secret value', { exact: true }).fill(certFixture('user_ed25519'));
  await form.getByRole('button', { name: 'Store' }).click();
  const row = page.getByTestId('secret-row-ci_key');
  await expect(row).toContainText(/ed25519 · SHA256:/, { timeout: 30_000 });
  await row.getByRole('button', { name: 'Attach certificate…' }).click();
  const attach = page.getByTestId('attach-certificate-dialog');
  await attach.getByLabel('Certificate', { exact: true }).fill(server.certify('user_ed25519'));
  await attach.getByRole('button', { name: 'Attach' }).click();
  await expect(attach).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('certificate-ci_key_cert')).toContainText(`user_ed25519-test · ${server.user} · from`);

  // A host signing in with the key takes its certificate along.
  await showSshNav(page, 'hosts');
  await page.getByRole('button', { name: 'New host' }).click();
  const dialog = page.getByTestId('host-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill('box');
  await dialog.getByLabel('Address', { exact: true }).fill('127.0.0.1');
  await dialog.getByRole('switch', { name: 'Override Port' }).click();
  await dialog.getByLabel('Port', { exact: true }).fill(String(server.port));
  await dialog.getByRole('switch', { name: 'Override User' }).click();
  await dialog.getByLabel('User', { exact: true }).fill(server.user);
  await dialog.getByRole('radio', { name: 'Key', exact: true }).check();
  await dialog.getByLabel('Private key secret', { exact: true }).selectOption('ci_key');
  await expect(dialog.getByLabel('Certificate secret', { exact: true })).toHaveValue('ci_key_cert');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  await page.getByTestId('host-row-box').dblclick();
  const trust = page.getByTestId('trust-dialog');
  await expect(trust).toBeVisible({ timeout: 30_000 });
  await expect(trust).toContainText(server.hostKeyFingerprint);
  await trust.getByRole('button', { name: 'Trust and connect' }).click();

  const terminal = page.getByTestId('ssh-terminal');
  await expect(page.getByTestId('editor-area').getByLabel('connected', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await terminal.click();
  // The shell, not an echo, answers: the arithmetic shows a real login.
  await page.keyboard.type('echo cert-$((40 + 2))');
  await page.keyboard.press('Enter');
  await expect(terminal).toContainText('cert-42', { timeout: 30_000 });
});
