import { expect, test, type Locator, type Page } from '@playwright/test';
import { LIVE_PATH } from '@wirebench/engine';
import { setMonacoText } from '../helpers/editor.js';
import { startFakeServer, type FakeServer, type FakeUser } from '../helpers/fake-server.js';
import {
  createProjectWithCalculator,
  createWorkspace,
  expandExplorer,
  openFirstRequest,
  saveAll,
} from '../helpers/project.js';
import {
  closeSyncPanel,
  headCalls,
  openSyncPanel,
  openTeamWorkspace,
  setAutoFetch,
  shareToTeam,
  signIn,
} from '../helpers/server.js';
import { calculatorEnvelope, syncBadge, SyncProfiles, SYNC_TIMEOUT, waitForSync } from '../helpers/sync.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

const PASSWORD = 'correct horse battery';
const ALICE: FakeUser = { email: 'alice@example.com', password: PASSWORD, displayName: 'Alice' };
const BOB: FakeUser = { email: 'bob@example.com', password: PASSWORD, displayName: 'Bob' };
const TEAM = 'Payments QA';

/** Main's git lookup probes only this path when the override is set: live updates need no git either. */
const NO_GIT = { WIREBENCH_E2E_GIT_PATH: '/nonexistent/git' };

/**
 * §13 criteria 1 and 2: what the socket reports reaches the open app within 5 s. Measured from the moment
 * the fake holds the change, so a push's own round trip is not part of it.
 */
const LIVE_TIMEOUT = 5_000;

/** §11: auto-fetch at ten minutes in both profiles, so nothing a test sees within seconds came from the timer. */
const AUTO_FETCH_SECONDS = 600;

/** A reconnect the app must not make would come within this: the first back-off is at most 1 s (§3.4). */
const NO_RECONNECT_WINDOW_MS = 5_000;

/** The calculator `Add` request's first operand as it appears in the tree and on the server. */
const intA = (value: string): string => `<tem:intA>${value}</tem:intA>`;

/** How many `/live` upgrades the fake saw, from any profile, answered or not. */
function liveAttempts(fake: FakeServer): number {
  return fake.requests.filter((request) => request.path === LIVE_PATH).length;
}

/** The badge's live dot: `data-state` `connected` or `connecting`, absent while live is off (§3.4). */
function liveDot(page: Page): Locator {
  return page.getByTestId('sync-live-dot');
}

/** Sets the open request's intA to `value` and saves, which commits and, for an editor, pushes. */
async function saveIntA(page: Page, value: string): Promise<void> {
  await setMonacoText(page, 'Request envelope XML', calculatorEnvelope(value));
  await expect(page.getByTestId('editor-tab-dirty')).toHaveCount(1, { timeout: 10_000 });
  await saveAll(page);
}

/** Opens the Sync panel, runs `check` on its "Also here" line, and closes the panel again. */
async function checkPresence(page: Page, check: (line: Locator) => Promise<void>): Promise<void> {
  const panel = await openSyncPanel(page);
  await check(panel.getByTestId('sync-presence'));
  await closeSyncPanel(page);
}

/**
 * Live updates (live-updates §11, e2e) against the fake server's `/live`, with no git on any profile and
 * auto-fetch at ten minutes. Each test names the success criteria (§13) it walks through.
 */
test.describe('live updates', () => {
  let profiles = new SyncProfiles();
  let fake: FakeServer | undefined;
  let soap: TestSoapServer | undefined;

  test.afterEach(async () => {
    const current = profiles;
    profiles = new SyncProfiles();
    const servers = [soap, fake];
    soap = undefined;
    fake = undefined;
    try {
      await current.dispose();
    } finally {
      // Each closes even when the one before it fails, so no fake server outlives its test.
      await Promise.allSettled(servers.map((server) => server?.close() ?? Promise.resolve()));
    }
  });

  test('a push, a demotion and a revoked session reach the open app within seconds; presence names the others', async () => {
    test.setTimeout(240_000);
    soap = await startTestSoapServer({ fixture: 'calculator' });
    const server = await startFakeServer({
      users: [ALICE, BOB],
      teams: [{ name: TEAM, members: { [ALICE.email]: 'member', [BOB.email]: 'member' } }],
    });
    fake = server;

    // --- Alice shares a workspace with the calculator in it; Bob is an editor there -------------
    const alice = await profiles.launch({ extraEnv: NO_GIT });
    await signIn(alice.window, server.url, ALICE);
    await createProjectWithCalculator(alice.window, soap);
    await saveAll(alice.window);
    await shareToTeam(alice.window, TEAM);
    const workspaceId = server.workspaceId('Workspace 1');
    server.setRole(workspaceId, BOB.email, 'editor');
    await setAutoFetch(alice.window, AUTO_FETCH_SECONDS);
    await expect(liveDot(alice.window)).toHaveAttribute('data-state', 'connected', { timeout: SYNC_TIMEOUT });

    const bob = await profiles.launch({ extraEnv: NO_GIT });
    await signIn(bob.window, server.url, BOB);
    await openTeamWorkspace(bob.window, 'Workspace 1');
    await waitForSync(bob.window, 'clean');
    await setAutoFetch(bob.window, AUTO_FETCH_SECONDS);
    await expect(liveDot(bob.window)).toHaveAttribute('data-state', 'connected', { timeout: SYNC_TIMEOUT });
    const bobToken = server.lastToken(BOB.email);
    expect(
      server
        .liveConnections()
        .map((connection) => connection.email)
        .sort(),
    ).toEqual([ALICE.email, BOB.email]);

    // --- Each Sync panel names the other, never its own user (criterion 1) ----------------------
    await checkPresence(alice.window, async (line) => {
      await expect(line).toContainText('Also here', { timeout: LIVE_TIMEOUT });
      await expect(line).toContainText('Bob');
      await expect(line).not.toContainText('Alice');
    });
    await checkPresence(bob.window, async (line) => {
      await expect(line).toContainText('Also here', { timeout: LIVE_TIMEOUT });
      await expect(line).toContainText('Alice');
      await expect(line).not.toContainText('Bob');
    });

    // --- Alice pushes; Bob shows 1 to pull within 5 s, with auto-fetch at ten minutes (criterion 1)
    await expandExplorer(alice.window, 'Request 1');
    await openFirstRequest(alice.window);
    await saveIntA(alice.window, '5555');
    await expect.poll(() => server.headContains(workspaceId, intA('5555')), { timeout: SYNC_TIMEOUT }).toBe(true);
    await waitForSync(bob.window, 'behind', LIVE_TIMEOUT);
    await expect(syncBadge(bob.window)).toContainText('1 to pull');
    await waitForSync(alice.window, 'clean');

    // --- Demoted to viewer: Bob's badge reads Viewer within 5 s (criterion 2) -------------------
    server.setRole(workspaceId, BOB.email, 'viewer');
    await expect(syncBadge(bob.window)).toContainText('Viewer', { timeout: LIVE_TIMEOUT });

    // --- Bob's device revoked: Sign in within 5 s, his name leaves Alice's panel, and nothing reconnects
    const attempts = liveAttempts(server);
    server.revoke(bobToken);
    await expect(syncBadge(bob.window)).toContainText('Sign in', { timeout: LIVE_TIMEOUT });
    await checkPresence(alice.window, async (line) => {
      await expect(line).toHaveCount(0, { timeout: LIVE_TIMEOUT });
    });
    await bob.window.waitForTimeout(NO_RECONNECT_WINDOW_MS);
    expect(liveAttempts(server)).toBe(attempts);
    expect(server.liveConnections().map((connection) => connection.email)).toEqual([ALICE.email]);
    await expect(liveDot(alice.window)).toHaveAttribute('data-state', 'connected');
  });

  test('a server without the live capability gets no socket attempt, and the app polls as before', async () => {
    test.setTimeout(120_000);
    const server = await startFakeServer({
      users: [ALICE],
      teams: [{ name: TEAM, members: { [ALICE.email]: 'member' } }],
      capabilities: ['sync'],
    });
    fake = server;

    const alice = await profiles.launch({ extraEnv: NO_GIT });
    const page = alice.window;
    await signIn(page, server.url, ALICE);
    await createWorkspace(page);
    await shareToTeam(page, TEAM);
    const token = server.lastToken(ALICE.email);

    // --- Criterion 5: the timer fetches at the user's interval, exactly as without this module ---
    await setAutoFetch(page, 2);
    const before = headCalls(server, token);
    await expect.poll(() => headCalls(server, token), { timeout: 20_000 }).toBeGreaterThanOrEqual(before + 2);

    // --- …and in all that time the app never tried the socket: /meta has no live (§3.4) ----------
    expect(liveAttempts(server)).toBe(0);
    expect(server.liveConnections()).toEqual([]);
    await expect(liveDot(page)).toHaveCount(0);
  });
});
