import { expect, test } from '@playwright/test';
import { startSshFixture, type SshFixture } from '@wirebench/ssh/test-helpers';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';
import { addPasswordHost, openAdvanced, trustHostKey } from '../helpers/ssh-host.js';

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

test('a host set to Latin-9 and vt220 opens its shell with that TERM and speaks that set both ways (#427)', async () => {
  test.setTimeout(180_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' } });
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Ops');

  await addPasswordHost(page, fixture, {
    name: 'legacy',
    beforeSave: async (dialog) => {
      await openAdvanced(dialog);
      await dialog.getByRole('combobox', { name: 'Character set' }).selectOption('iso-8859-15');
      // Preferences → SSH supplies xterm-256color; Override makes the field this host's own.
      await expect(dialog.getByText('xterm-256color · from Preferences')).toBeVisible();
      await dialog.getByRole('switch', { name: 'Override Terminal type' }).click();
      await dialog.getByLabel('Terminal type', { exact: true }).fill('vt220');
    },
  });

  await page.getByTestId('host-row-legacy').click();
  await page.getByTestId('rail-host-details').click();
  const details = page.getByTestId('host-details');
  await expect(details).toContainText('vt220');
  await expect(details).toContainText('ISO-8859-15');
  await page.keyboard.press('Escape');

  await page.getByTestId('host-row-legacy').dblclick();
  await trustHostKey(page, fixture);
  const terminal = page.getByTestId('ssh-terminal');
  await expect(page.getByTestId('editor-area').getByLabel('connected', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  expect(fixture.lastTerm).toBe('vt220');

  // The fixture's shell echoes what it reads: Latin-9 bytes on the wire, UTF-8 again on the screen.
  await terminal.click();
  await page.keyboard.type('café €');
  await expect(terminal).toContainText('café €', { timeout: 30_000 });
  const latin9 = Buffer.from([...Buffer.from('caf'), 0xe9, 0x20, 0xa4]);
  expect(Buffer.from(fixture.shellInput).includes(latin9)).toBe(true);
});
