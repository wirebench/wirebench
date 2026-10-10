import { expect, test, type Page } from '@playwright/test';
import { createBareRemote, remoteFiles, remoteLog, runGit } from '../helpers/git-remote.js';
import { expandExplorer, openFirstRequest, saveAll } from '../helpers/project.js';
import {
  joinSharedWorkspace,
  pullNow,
  startSharedWorkspace,
  syncBadge,
  SyncProfiles,
  SYNC_TIMEOUT,
} from '../helpers/sync.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

const BEN = { name: 'Ben', email: 'ben@example.com' };
/** A value distinctive enough that finding it anywhere in the remote's history is proof of a leak. */
const WRONG = 'wrong-7f3e9c41d2';
const RIGHT = 'pass';

/** The remote's sealed vault entries as blob ids, so a re-seal shows as a change; '' before the first. */
function vaultBlobs(dir: string): string {
  return remoteFiles(dir)
    .filter((file) => /^team-secrets\/values\/[^/]+\.yaml$/.test(file))
    .map((file) => runGit(['--git-dir', dir, 'rev-parse', `main:${file}`]).trim())
    .join(',');
}

async function authPanel(page: Page) {
  await expandExplorer(page, 'Request 1');
  await openFirstRequest(page);
  await page.getByRole('tablist', { name: 'Request tabs' }).getByRole('tab', { name: 'Auth' }).click();
  return page.getByTestId('inspector-panel-request');
}

async function openSyncPanel(page: Page) {
  await syncBadge(page).click();
  return page.getByTestId('sync-panel');
}

async function closeSyncPanel(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('sync-panel')).toHaveCount(0);
}

/**
 * Team secrets end to end (spec §13): A shares and sets a password; B joins and waits; A approves
 * B after reading the fingerprint; B sends with A's value, and with A's next value, having typed
 * nothing. The remote's history never holds a value. Removing B marks the value for rotation.
 */
test.describe('shared workspaces: team secrets', () => {
  let profiles = new SyncProfiles();
  let server: TestSoapServer | undefined;

  test.afterEach(async () => {
    const current = profiles;
    profiles = new SyncProfiles();
    try {
      await current.dispose();
    } finally {
      await server?.close();
      server = undefined;
    }
  });

  test('an approved machine uses the team’s values without typing them, and the remote never holds one', async () => {
    test.setTimeout(300_000);
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    const remote = await createBareRemote();
    profiles.track(remote.dir);

    const a = await profiles.launch();
    // Plan decision 23: team secrets refuse to make a key without OS encryption (headless Linux CI).
    const keychain = await a.app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
    test.skip(!keychain, 'Team secrets need an OS keychain, which this environment does not have.');

    await startSharedWorkspace(a.window, server, remote);
    const pageA = a.window;

    // --- A: Basic auth with a first (wrong) value --------------------------------------------
    const panelA = await authPanel(pageA);
    await pageA.getByTestId('request-endpoint').fill(`${server.url}/auth/basic`);
    await pageA.getByTestId('auth-inherit').uncheck();
    await panelA.getByLabel('Authentication type').selectOption('basic');
    await panelA.getByLabel('Username').fill('user');
    await panelA.getByRole('button', { name: 'Set…' }).click();
    await panelA.getByPlaceholder('Enter password').fill(WRONG);
    await panelA.getByRole('button', { name: 'Save' }).click();
    await expect(panelA.getByLabel('Password')).toHaveText('••••••••');
    await saveAll(pageA);
    // The vault entry, not a commit subject: the request edits saved alongside it make the commit's message the generated one.
    await expect.poll(() => vaultBlobs(remote.dir), { timeout: SYNC_TIMEOUT }).not.toBe('');

    // --- B joins and asks; its send says it is waiting ---------------------------------------
    const b = await profiles.launch({ identity: BEN });
    await joinSharedWorkspace(b.window, remote.url);
    await expect
      .poll(() => remoteLog(remote.dir), { timeout: SYNC_TIMEOUT })
      .toContain('Request team secrets access for Ben');
    const pageB = b.window;
    const authB = await authPanel(pageB);
    await pageB.getByTestId('request-send').click();
    await expect(
      pageB.getByText('This machine is waiting for an admin to approve it for team secrets.').first(),
    ).toBeVisible({ timeout: 20_000 });
    const syncB = await openSyncPanel(pageB);
    const fingerprintB = (await syncB.getByTestId('team-secrets-me').textContent()) ?? '';
    await closeSyncPanel(pageB);

    // --- A pulls, sees one waiting, checks the fingerprint and approves ----------------------
    await pullNow(pageA);
    await expect(syncBadge(pageA)).toContainText('1 waiting', { timeout: SYNC_TIMEOUT });
    const syncA = await openSyncPanel(pageA);
    const row = syncA.getByTestId('team-secrets-pending-row');
    await expect(row).toContainText('Ben');
    const shown = (await row.locator('.font-mono').textContent())?.trim() ?? '';
    expect(shown).not.toBe('');
    expect(fingerprintB).toContain(shown);
    await syncA.getByTestId('team-secrets-approve').click();
    await expect(row).toHaveCount(0);
    await closeSyncPanel(pageA);
    await expect
      .poll(() => remoteLog(remote.dir), { timeout: SYNC_TIMEOUT })
      .toContain('Approve team secrets access for Ben');

    // --- B pulls: A's value is used, nothing typed (the server refuses it) ------------------
    await pullNow(pageB);
    await expect(authB.getByTestId('secret-missing')).toHaveCount(0, { timeout: SYNC_TIMEOUT });
    await pageB.getByTestId('request-send').click();
    await expect(pageB.getByTestId('response-status')).toContainText('401', { timeout: 20_000 });

    // --- A replaces the value; B's next send after a pull succeeds ---------------------------
    const sealedBefore = vaultBlobs(remote.dir);
    await panelA.getByRole('button', { name: 'Replace…' }).click();
    await panelA.getByPlaceholder('Enter password').fill(RIGHT);
    await panelA.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => vaultBlobs(remote.dir), { timeout: SYNC_TIMEOUT }).not.toBe(sealedBefore);
    await pullNow(pageB);
    await expect
      .poll(
        async () => {
          await pageB.getByTestId('request-send').click();
          return (await pageB.getByTestId('response-status').textContent()) ?? '';
        },
        { timeout: SYNC_TIMEOUT },
      )
      .toContain('200');

    // --- No value anywhere in the remote's history ------------------------------------------
    expect(runGit(['--git-dir', remote.dir, 'log', '-p', '--all'])).not.toContain(WRONG);

    // --- A removes B: the value B could read is marked Rotate --------------------------------
    const again = await openSyncPanel(pageA);
    await again.getByTestId('team-secrets-remove').click();
    await pageA.getByTestId('team-secrets-remove-confirm').click();
    await expect(again.getByTestId('team-secrets-rotate-row')).toContainText('Ben', { timeout: SYNC_TIMEOUT });
    await closeSyncPanel(pageA);
    await expect(panelA.getByTestId('secret-rotate')).toHaveText('Rotate');
  });
});
