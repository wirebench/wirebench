import { expect, test } from '@playwright/test';
import { startFakeServer, type FakeServer, type FakeUser } from '../helpers/fake-server.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { shareToTeam, signIn } from '../helpers/server.js';
import { SyncProfiles, SYNC_TIMEOUT } from '../helpers/sync.js';

const ALICE: FakeUser = { email: 'alice@example.com', password: 'correct horse battery', displayName: 'Alice' };
const TEAM = 'Payments QA';
/** Main's git lookup probes only this path when the override is set: a server share needs no git. */
const NO_GIT = { WIREBENCH_E2E_GIT_PATH: '/nonexistent/git' };
/** A nudge reaches the open app within this, as live-updates' own spec measures. */
const LIVE_TIMEOUT = 5_000;

/**
 * Webhook capture (webhook-capture spec §7, e2e) against the fake server: a catch URL is made from the
 * Webhooks node, a sender POSTs to it, and the capture appears in the open tab without a refresh.
 */
test.describe('webhook capture', () => {
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

  test('create a catch URL, POST to it, watch the capture arrive live, and open it', async () => {
    test.setTimeout(180_000);
    const server = await startFakeServer({
      users: [ALICE],
      teams: [{ name: TEAM, members: { [ALICE.email]: 'member' } }],
      hooks: true,
    });
    fake = server;

    // --- Alice shares a workspace on the server; the Webhooks node appears -----------------------
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

    // --- New catch URL… answers 202; its tab opens on the empty list ----------------------------
    await root.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'New catch URL…' }).click();
    const dialog = page.getByTestId('catch-url-settings');
    await dialog.getByTestId('catch-url-name').fill('Payments');
    await dialog.getByTestId('catch-url-status').fill('202');
    await dialog.getByTestId('catch-url-save').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('catch-url-row').filter({ hasText: 'Payments' })).toBeVisible();
    const tab = page.getByTestId('catch-url-tab');
    await expect(tab.getByTestId('capture-empty')).toBeVisible({ timeout: SYNC_TIMEOUT });
    const address = server.catchUrlOf(server.workspaceId('Workspace 1'), 'Payments');
    await expect(tab.getByTestId('catch-url-address')).toHaveText(address);

    // --- A sender POSTs; the capture appears in the open tab without a click ---------------------
    const answer = await fetch(`${address}/orders?id=7`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-trace': 'e2e' },
      body: '{"order":7}',
    });
    expect(answer.status).toBe(202);
    const row = tab.getByTestId('capture-row');
    await expect(row).toHaveCount(1, { timeout: LIVE_TIMEOUT });
    await expect(row).toContainText('POST');
    await expect(row).toContainText('/orders');

    // --- Open it: the body as it arrived, the headers in order, and the details ------------------
    await row.click();
    const viewer = tab.getByTestId('capture-viewer');
    await expect(viewer).toBeVisible();
    await viewer.getByTestId('rest-response-view-raw').click();
    await expect(viewer.getByTestId('rest-response-raw')).toContainText('{"order":7}');
    await viewer.getByRole('tab', { name: /Headers/ }).click();
    await expect(viewer.getByTestId('capture-headers')).toContainText('x-trace');
    await expect(viewer.getByTestId('capture-headers')).toContainText('application/json');
    await viewer.getByRole('tab', { name: 'Details' }).click();
    await expect(viewer.getByTestId('capture-details')).toContainText('id=7');
  });
});
