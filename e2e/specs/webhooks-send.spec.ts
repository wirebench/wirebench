import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { startFakeServer, type FakeServer, type FakeUser } from '../helpers/fake-server.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { apiRow, chooseContextMenuItem, openImportOpenApi, responseStatus, sendRest } from '../helpers/rest.js';
import { shareToTeam, signIn } from '../helpers/server.js';
import { SyncProfiles, SYNC_TIMEOUT } from '../helpers/sync.js';
import { startTestRestServer, type TestRestServer, type TestRestServerDocument } from '../helpers/test-server.js';

const ALICE: FakeUser = { email: 'alice@example.com', password: 'correct horse battery', displayName: 'Alice' };
const TEAM = 'Payments QA';
/** Main's git lookup probes only this path when the override is set: a server share needs no git. */
const NO_GIT = { WIREBENCH_E2E_GIT_PATH: '/nonexistent/git' };
/** A live capture reaches the open tab within this, as `server-webhooks.spec.ts` measures. */
const LIVE_TIMEOUT = 5_000;

const craftedDir = fileURLToPath(new URL('../../fixtures/openapi/crafted/', import.meta.url));

/** One of the crafted fixtures, read from disk. */
function fixtureText(...parts: string[]): string {
  return readFileSync(join(craftedDir, ...parts), 'utf-8');
}

/** A webhook collection folder's explorer row, by its exact name (e.g. an imported group). */
function webhookFolderRow(page: Page, name: string): Locator {
  return page.getByTestId('webhook-folder-row').filter({ has: page.getByText(name, { exact: true }) });
}

/** A webhook item's explorer row, by its exact name — a webhook's own name never carries a suffix. */
function webhookRequestRow(page: Page, name: string): Locator {
  return page.getByTestId('webhook-request-row').filter({ has: page.getByText(name, { exact: true }) });
}

/**
 * Import, send, save as, and Update Definition, for a project's webhook collection (openapi-webhooks-
 * import, e2e), against the fake server so the catch URL feature is there to send through.
 *
 * The document lives on the in-process REST test server rather than on disk, so the same URL can be
 * re-pointed at the `update` pair's `next` fixture for Update Definition, exactly as
 * `rest-update-definition.spec.ts` does for a plain REST API.
 */
test.describe('webhooks: import, send, save as, and update', () => {
  let profiles = new SyncProfiles();
  let fake: FakeServer | undefined;
  let restServer: TestRestServer | undefined;
  let documents: Record<string, TestRestServerDocument> = {};

  test.afterEach(async () => {
    const current = profiles;
    profiles = new SyncProfiles();
    const server = fake;
    fake = undefined;
    const rest = restServer;
    restServer = undefined;
    documents = {};
    try {
      await current.dispose();
    } finally {
      await Promise.all([server?.close(), rest?.close()]);
    }
  });

  test('imports webhooks & callbacks, sends one, saves a capture as a new one, and updates the group', async () => {
    test.setTimeout(180_000);
    documents = {
      '/webhooks/openapi.yaml': { body: fixtureText('webhooks', 'openapi.yaml'), contentType: 'application/yaml' },
    };
    restServer = await startTestRestServer({ documents });
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
    await expect(root).toContainText('Webhook inbox');

    // --- A catch URL to send the webhook item at, and to watch the capture arrive in -------------
    await chooseContextMenuItem(page, root, 'New catch URL…');
    const catchDialog = page.getByTestId('catch-url-settings');
    await catchDialog.getByTestId('catch-url-name').fill('Petstore dev');
    await catchDialog.getByTestId('catch-url-save').click();
    await expect(catchDialog).toBeHidden();
    const catchRow = page.getByTestId('catch-url-row').filter({ hasText: 'Petstore dev' });
    await expect(catchRow).toBeVisible();

    // --- Import the document, webhooks & callbacks ticked (the default) --------------------------
    await openImportOpenApi(page);
    await expect(page.getByTestId('import-openapi-webhooks')).toBeChecked();
    await page.getByTestId('import-openapi-url').fill(`${restServer.url}/webhooks/openapi.yaml`);
    await page.getByTestId('import-openapi-submit').click();
    const summary = page.getByTestId('import-openapi-summary');
    await expect(summary).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('import-openapi-webhooks-result')).toContainText('4 webhooks & callbacks');
    await page.getByTestId('import-openapi-done').click();

    // --- The project's Webhooks node holds the imported group, with the webhook and the callback --
    const collectionRow = page.getByTestId('webhook-collection-row');
    await expect(collectionRow).toBeVisible({ timeout: 20_000 });
    await collectionRow.click();
    const groupRow = webhookFolderRow(page, 'Petstore API');
    await expect(groupRow).toBeVisible({ timeout: 20_000 });
    await groupRow.click();
    await expect(webhookRequestRow(page, 'newPet')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('webhook-request-row').filter({ hasText: 'onPetEvent' })).toBeVisible({
      timeout: 20_000,
    });

    // --- Webhooks ▸ Settings… → Catch URLs ▸ Petstore dev → Save: the group's target -------------
    await chooseContextMenuItem(page, collectionRow, 'Settings…');
    const settings = page.getByTestId('webhook-settings');
    await expect(settings).toBeVisible({ timeout: 20_000 });
    await settings.getByTestId('webhook-settings-catch-urls').click();
    await page.getByRole('menuitem', { name: 'Petstore dev' }).click();
    await settings.getByTestId('webhook-settings-save').click();
    await expect(settings).toBeHidden();

    // --- Open newPet, Send: the target resolves and the answer comes back 2xx --------------------
    await webhookRequestRow(page, 'newPet').dblclick();
    await expect(page.getByTestId('rest-editor')).toBeVisible({ timeout: 20_000 });
    await sendRest(page);
    await expect(responseStatus(page)).toContainText(/2\d\d/);

    // --- The Petstore dev tab: the capture arrived, its body carries the generated pet -----------
    await catchRow.dblclick();
    const tab = page.getByTestId('catch-url-tab');
    await expect(tab).toBeVisible();
    const captureRow = tab.getByTestId('capture-row');
    await expect(captureRow).toHaveCount(1, { timeout: LIVE_TIMEOUT });
    await expect(captureRow).toContainText('POST');
    await expect(captureRow).toContainText('/newPet');
    await captureRow.click();
    const viewer = tab.getByTestId('capture-viewer');
    await expect(viewer).toBeVisible();
    await viewer.getByTestId('rest-response-view-raw').click();
    await expect(viewer.getByTestId('rest-response-raw')).toContainText('"name"');

    // --- Save as webhook…, into Webhooks, named replayed -----------------------------------------
    await viewer.getByTestId('capture-save-as-webhook').click();
    const saveAsDialog = page.getByTestId('save-as-webhook-dialog');
    await expect(saveAsDialog).toBeVisible();
    await saveAsDialog.getByTestId('save-as-webhook-name').fill('replayed');
    await saveAsDialog.getByTestId('save-as-webhook-save').click();
    await expect(saveAsDialog).toBeHidden();
    await expect(webhookRequestRow(page, 'replayed')).toBeVisible({ timeout: 20_000 });

    // --- The same URL now answers with the next document: Update Definition sees the difference ---
    documents['/webhooks/openapi.yaml'] = {
      body: fixtureText('update', 'webhooks-next.yaml'),
      contentType: 'application/yaml',
    };
    await chooseContextMenuItem(page, apiRow(page, 'Petstore API'), 'Update Definition…');
    const updateDialog = page.getByTestId('rest-update-dialog');
    await expect(updateDialog).toBeVisible({ timeout: 20_000 });
    const webhooksReport = page.getByTestId('rest-update-webhooks');
    await expect(webhooksReport).toBeVisible({ timeout: 30_000 });
    await expect(webhooksReport).toContainText('Webhooks +1 ~1');
    await expect(page.getByTestId('rest-update-webhooks-added')).toContainText('petDeleted');
    await expect(page.getByTestId('rest-update-webhooks-removed')).toContainText('onPetEvent');
    await expect(page.getByTestId('rest-update-webhooks-changed')).toContainText('newPet');
    await page.getByTestId('rest-update-apply').click();
    await expect(updateDialog).toBeHidden({ timeout: 30_000 });

    // --- petDeleted joined the group; onPetEvent is kept and badged orphaned rather than deleted --
    await expect(webhookRequestRow(page, 'petDeleted')).toBeVisible({ timeout: 20_000 });
    const onPetEventRow = page.getByTestId('webhook-request-row').filter({ hasText: 'onPetEvent' });
    await expect(onPetEventRow.getByTestId('explorer-orphaned-badge')).toBeVisible({ timeout: 20_000 });
  });
});
