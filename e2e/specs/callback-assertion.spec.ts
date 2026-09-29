import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Locator } from '@playwright/test';
import { startFakeServer, type FakeServer, type FakeUser } from '../helpers/fake-server.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { chooseContextMenuItem, createApi, createRestRequest, saveRequest, setMethodAndUrl } from '../helpers/rest.js';
import { shareToTeam, signIn } from '../helpers/server.js';
import { SyncProfiles, SYNC_TIMEOUT } from '../helpers/sync.js';

const ALICE: FakeUser = { email: 'alice@example.com', password: 'correct horse battery', displayName: 'Alice' };
const TEAM = 'Payments QA';
/** Main's git lookup probes only this path when the override is set: a server share needs no git. */
const NO_GIT = { WIREBENCH_E2E_GIT_PATH: '/nonexistent/git' };
const CATCH_URL = 'orders-hook';

/** The system under test, and the callback its `POST /orders` owes the catch URL. */
interface Target {
  readonly url: string;
  /** Posts every callback owed so far to the catch URL; resolves once the catch URL has answered each. */
  release(): Promise<void>;
  close(): Promise<void>;
}

/**
 * `POST /orders` answers 201 at once and owes `{orderId, status: 'paid'}` to `catchUrl/events`, which the
 * test releases once it has seen the step wait: the callback is the request's, and the waiting row is
 * on screen for as long as the test needs it rather than for a poll's luck.
 */
async function startTarget(catchUrl: string): Promise<Target> {
  let owed = 0;
  const server = createServer((request, response) => {
    request.resume();
    if (request.method !== 'POST' || request.url !== '/orders') {
      response.writeHead(404).end();
      return;
    }
    owed += 1;
    response.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ orderId: 'ord-1' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    async release() {
      for (; owed > 0; owed -= 1) {
        const answer = await fetch(`${catchUrl}/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ orderId: 'ord-1', status: 'paid' }),
        });
        expect(answer.status).toBe(200);
      }
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Types `text` into a commit-on-Enter field and waits for the store to take it. The field is keyed by
 * its stored value, so a landed commit re-mounts it: the marker set before Enter is gone from the new
 * node. The next edit then builds on this one rather than on the assertion as it was before.
 */
async function commit(field: Locator, text: string): Promise<void> {
  await field.fill(text);
  // Typed structurally: the e2e project compiles without the DOM library.
  await field.evaluate((node: { setAttribute(name: string, value: string): void }) => {
    node.setAttribute('data-e2e-stale', 'true');
  });
  await field.press('Enter');
  await expect(field).not.toHaveAttribute('data-e2e-stale', 'true');
  await expect(field).toHaveValue(text);
}

/**
 * Callback assertions (callback-assertion spec §5, e2e) against the fake server: a sequence step whose
 * request makes the target post to a catch URL waits for that capture, says what it waits for, and
 * passes on it; the run panel links to the capture in the catch URL's tab.
 */
test.describe('callback assertions', () => {
  let profiles = new SyncProfiles();
  let fake: FakeServer | undefined;
  let target: Target | undefined;

  test.afterEach(async () => {
    const current = profiles;
    profiles = new SyncProfiles();
    const server = fake;
    fake = undefined;
    const system = target;
    target = undefined;
    try {
      await current.dispose();
    } finally {
      await system?.close();
      await server?.close();
    }
  });

  test('a sequence step passes on the callback its request causes', async () => {
    test.setTimeout(180_000);
    const server = await startFakeServer({
      users: [ALICE],
      teams: [{ name: TEAM, members: { [ALICE.email]: 'member' } }],
      hooks: true,
    });
    fake = server;

    // --- Alice shares a workspace on the server and makes a catch URL in it ---------------------
    const alice = await profiles.launch({ extraEnv: NO_GIT });
    const page = alice.window;
    await signIn(page, server.url, ALICE);
    await createWorkspace(page);
    await createProject(page, 'Orders');
    await shareToTeam(page, TEAM);
    await expect(page.getByTestId('sync-live-dot')).toHaveAttribute('data-state', 'connected', {
      timeout: SYNC_TIMEOUT,
    });
    const root = page.getByTestId('webhooks-row');
    await expect(root).toBeVisible({ timeout: SYNC_TIMEOUT });
    await chooseContextMenuItem(page, root, 'New catch URL…');
    const catchDialog = page.getByTestId('catch-url-settings');
    await catchDialog.getByTestId('catch-url-name').fill(CATCH_URL);
    await catchDialog.getByTestId('catch-url-save').click();
    await expect(catchDialog).toBeHidden();
    await expect(page.getByTestId('catch-url-row').filter({ hasText: CATCH_URL })).toBeVisible();

    const system = await startTarget(server.catchUrlOf(server.workspaceId('Workspace 1'), CATCH_URL));
    target = system;

    // --- A saved request that places an order ---------------------------------------------------
    await createApi(page, 'Orders API', system.url);
    await createRestRequest(page, 'Orders API', 'Place order');
    await setMethodAndUrl(page, 'POST', '/orders');
    await saveRequest(page);

    // --- A sequence whose one step expects the order's callback ---------------------------------
    await chooseContextMenuItem(page, page.getByTestId('explorer-project-row').first(), 'New Sequence');
    const tab = page.getByTestId('sequence-tab');
    await expect(tab).toBeVisible({ timeout: 20_000 });
    await tab.getByTestId('sequence-add-step').click();
    await page.getByTestId('sequence-add-step-input').fill('Place order');
    await page.getByTestId('sequence-add-step-item').filter({ hasText: 'Place order' }).first().click();
    await expect(tab.getByTestId('sequence-step')).toHaveCount(1);

    await tab.getByTestId('sequence-add-assertion').click();
    const kind = tab.getByTestId('sequence-assertion-kind');
    await expect(kind).toHaveValue('status');
    await kind.selectOption('callback');
    await expect(kind).toHaveValue('callback');
    // A new callback starts on the workspace's first catch URL, POST, and one body check `$` is present.
    await expect(tab.getByTestId('sequence-callback-catch-url')).toHaveValue(CATCH_URL);
    await expect(tab.getByTestId('sequence-callback-method')).toHaveValue('POST');
    await commit(tab.getByTestId('sequence-callback-within'), '10');
    await commit(tab.getByTestId('sequence-callback-expect-row-path'), '$.status');
    const check = tab.getByTestId('sequence-callback-expect-row-check');
    await check.selectOption('equals');
    await expect(check).toHaveValue('equals');
    await commit(tab.getByTestId('sequence-callback-expect-row-value'), 'paid');

    // --- Run: the step waits for the catch URL, then passes on the callback ---------------------
    await tab.getByTestId('sequence-run').click();
    await expect(tab.getByTestId('sequence-run-waiting')).toHaveText(`1. waiting for ${CATCH_URL}… (up to 10 s)`, {
      timeout: 20_000,
    });
    await system.release();
    await expect(tab.getByTestId('sequence-run-status')).toHaveText('Run passed', { timeout: 20_000 });
    await expect(tab.getByTestId('sequence-run-waiting')).toHaveCount(0);

    const step = tab.getByTestId('sequence-run-step');
    await expect(step).toHaveCount(1);
    await expect(step).toHaveAttribute('data-outcome', 'passed');
    await expect(step).toContainText('201');
    // A passed step's details start folded.
    await step.locator('summary').click();
    const callback = step.locator('[data-testid="sequence-run-assertion"][data-type="callback"]');
    await expect(callback).toBeVisible();
    await expect(callback).toHaveAttribute('data-outcome', 'passed');
    await expect(callback).toContainText('matched capture');

    // --- The link opens the catch URL's tab on that capture -------------------------------------
    const link = callback.getByTestId('sequence-run-capture-link');
    await expect(link).toBeEnabled();
    await link.click();
    const catchTab = page.getByTestId('catch-url-tab');
    await expect(catchTab).toBeVisible({ timeout: 20_000 });
    const row = catchTab.getByTestId('capture-row');
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('aria-current', 'true');
    await expect(row).toContainText('/events');
    await expect(catchTab.getByTestId('capture-viewer')).toBeVisible();
  });
});
