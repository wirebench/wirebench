import { expect, test, type Locator, type Page } from '@playwright/test';
import { startFakeServer, type FakeServer, type FakeUser } from '../helpers/fake-server.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { chooseContextMenuItem, responseStatus, sendRest } from '../helpers/rest.js';
import { shareToTeam, signIn } from '../helpers/server.js';
import { SyncProfiles, SYNC_TIMEOUT } from '../helpers/sync.js';

const ALICE: FakeUser = { email: 'alice@example.com', password: 'correct horse battery', displayName: 'Alice' };
const TEAM = 'Payments QA';
/** Main's git lookup probes only this path when the override is set: a server share needs no git. */
const NO_GIT = { WIREBENCH_E2E_GIT_PATH: '/nonexistent/git' };
/** A live capture reaches the open tab within this, as `server-webhooks.spec.ts` measures. */
const LIVE_TIMEOUT = 5_000;
const SECRET = 'abc123def456ghi789';
const OTHER_SECRET = 'zzz999yyy888xxx777';

/**
 * Types a value into a SecretField that is not in edit mode, commits it with Enter, and waits for the
 * keychain round trip to finish (the field leaves edit mode and offers *Replace…*), so the Send that
 * follows signs with the stored value rather than racing the field's own flush.
 */
async function enterSecret(scope: Locator, button: 'Set…' | 'Replace…', value: string): Promise<void> {
  await scope.getByRole('button', { name: button }).click();
  const input = scope.locator('input[type="password"]');
  await input.fill(value);
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await expect(scope.getByRole('button', { name: 'Replace…' })).toBeVisible();
}

/** Waits for the open catch URL tab to list `count` captures, and returns the newest (listed first). */
async function newestCapture(page: Page, count: number): Promise<Locator> {
  const rows = page.getByTestId('catch-url-tab').getByTestId('capture-row');
  await expect(rows).toHaveCount(count, { timeout: LIVE_TIMEOUT });
  return rows.first();
}

/**
 * Webhook signatures (webhook-signatures spec, e2e) against the fake server: a catch URL verifies
 * *HMAC of body* with a secret, a webhook item signs with the same scheme and secret from the
 * keychain, and the capture shows ✓; after the item's secret is replaced, the next capture shows ✗
 * with *digest mismatch* in its details.
 */
test.describe('webhook signatures', () => {
  let profiles = new SyncProfiles();
  let fake: FakeServer | undefined;

  test.afterEach(async () => {
    const current = profiles;
    profiles = new SyncProfiles();
    const server = fake;
    fake = undefined;
    try {
      await current.dispose();
    } finally {
      await server?.close();
    }
  });

  test('a signed webhook verifies at the catch URL; a changed secret fails as a digest mismatch', async () => {
    test.setTimeout(180_000);
    const server = await startFakeServer({
      users: [ALICE],
      teams: [{ name: TEAM, members: { [ALICE.email]: 'member' } }],
      hooks: true,
    });
    fake = server;

    // --- Alice shares a workspace on the server; the Webhook inbox node appears -------------------
    const alice = await profiles.launch({ extraEnv: NO_GIT });
    const page = alice.window;
    await signIn(page, server.url, ALICE);
    await createWorkspace(page);
    await createProject(page, 'Demo');
    await shareToTeam(page, TEAM);
    await expect(page.getByTestId('sync-live-dot')).toHaveAttribute('data-state', 'connected', {
      timeout: SYNC_TIMEOUT,
    });
    const root = page.getByTestId('webhooks-row');
    await expect(root).toBeVisible({ timeout: SYNC_TIMEOUT });

    // --- 1. A catch URL "Signed" verifying HMAC of body with the secret --------------------------
    await chooseContextMenuItem(page, root, 'New catch URL…');
    const catchDialog = page.getByTestId('catch-url-settings');
    await catchDialog.getByTestId('catch-url-name').fill('Signed');
    await catchDialog.getByTestId('catch-url-save').click();
    await expect(catchDialog).toBeHidden();
    const catchRow = page.getByTestId('catch-url-row').filter({ hasText: 'Signed' });
    await expect(catchRow).toBeVisible();
    await chooseContextMenuItem(page, catchRow, 'Settings…');
    await expect(catchDialog.getByTestId('catch-url-signature')).toBeVisible();
    await catchDialog.getByTestId('catch-url-signature-scheme').selectOption('hmac');
    await catchDialog.getByTestId('catch-url-signature-secret').fill(SECRET);
    await catchDialog.getByTestId('catch-url-save').click();
    await expect(catchDialog).toBeHidden();

    // --- 2. A webhook item aimed at it, signing with the same scheme and secret -----------------
    await chooseContextMenuItem(page, page.getByTestId('explorer-project-row'), 'New Webhook');
    const editor = page.getByTestId('rest-editor');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    const collectionRow = page.getByTestId('webhook-collection-row');
    await chooseContextMenuItem(page, collectionRow, 'Settings…');
    const settings = page.getByTestId('webhook-settings');
    await expect(settings).toBeVisible({ timeout: 20_000 });
    await settings.getByTestId('webhook-settings-catch-urls').click();
    await page.getByRole('menuitem', { name: 'Signed' }).click();
    await settings.getByTestId('webhook-settings-save').click();
    await expect(settings).toBeHidden();

    await editor.getByRole('tab', { name: 'Signing' }).click();
    const signing = editor.getByTestId('rest-signing');
    await signing.getByTestId('signing-mode').selectOption('hmac');
    await enterSecret(signing, 'Set…', SECRET);
    await sendRest(page);
    await expect(responseStatus(page)).toContainText(/2\d\d/);

    await catchRow.dblclick();
    let row = await newestCapture(page, 1);
    await expect(row.getByTestId('capture-signature-badge')).toHaveAttribute('data-verdict', 'verified');

    // --- 3. Replace the item's secret, send again: ✗ digest mismatch -----------------------------
    // Back through the editor strip: the explorer's Webhooks node may be collapsed, the tab is not.
    await page
      .getByRole('tablist', { name: 'Open editors' })
      .getByRole('tab', { name: /^Webhook/ })
      .click();
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await editor.getByRole('tab', { name: 'Signing' }).click();
    await enterSecret(editor.getByTestId('rest-signing'), 'Replace…', OTHER_SECRET);
    await sendRest(page);
    await expect(responseStatus(page)).toContainText(/2\d\d/);

    await catchRow.dblclick();
    row = await newestCapture(page, 2);
    await expect(row.getByTestId('capture-signature-badge')).toHaveAttribute('data-verdict', 'failed');
    await row.click();
    const viewer = page.getByTestId('catch-url-tab').getByTestId('capture-viewer');
    await expect(viewer).toBeVisible();
    await viewer.getByRole('tab', { name: 'Details' }).click();
    await expect(viewer.getByTestId('capture-signature-verdict')).toContainText('digest mismatch');
  });
});
