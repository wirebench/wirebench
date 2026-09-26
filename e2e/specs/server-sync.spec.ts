import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { setMonacoText } from '../helpers/editor.js';
import { startFakeServer, type FakeServer, type FakeUser } from '../helpers/fake-server.js';
import { runCommand } from '../helpers/palette.js';
import {
  createProjectWithCalculator,
  createWorkspace,
  expandExplorer,
  openFirstRequest,
  saveAll,
} from '../helpers/project.js';
import {
  closeSyncPanel,
  completeSignIn,
  headCalls,
  openSyncPanel,
  openTeamDialog,
  openTeamWorkspace,
  shareToTeam,
  signIn,
} from '../helpers/server.js';
import {
  awaitConflict,
  calculatorEnvelope,
  envelopeText,
  keepTheirsForAll,
  openConflictResolver,
  pullNow,
  pushNow,
  sharedTreeDir,
  syncBadge,
  SyncProfiles,
  SYNC_TIMEOUT,
  waitForSync,
} from '../helpers/sync.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

const PASSWORD = 'correct horse battery';
const ALICE: FakeUser = { email: 'alice@example.com', password: PASSWORD, displayName: 'Alice' };
const BOB: FakeUser = { email: 'bob@example.com', password: PASSWORD, displayName: 'Bob' };
const TEAM = 'Payments QA';

/**
 * Main's git lookup probes only this path when the override is set, so every profile here is a
 * machine without git: server sync must not need it (server-sync §13, criterion 2).
 */
const NO_GIT = { WIREBENCH_E2E_GIT_PATH: '/nonexistent/git' };

/**
 * These tests prove the polling path (server-sync §3.4), so their fake offers no live socket. With one,
 * a connected app waits the 300 s safety net (live-updates §3.4) and announcements stand in for the
 * fetches this spec counts. `server-live.spec.ts` covers the socket.
 */
const SYNC_ONLY = ['sync'] as const;

/** The spec's words for a viewer's disabled push (server-sync §3.4). */
const VIEWER_REASON = 'You have viewer access in this workspace; changes stay on this machine.';

/** The calculator `Add` request's first operand as it appears in the tree and on the server. */
const intA = (value: string): string => `<tem:intA>${value}</tem:intA>`;

/** Whether any file under `dir` contains `needle`. */
function anyFileContains(dir: string, needle: string): boolean {
  return readdirSync(dir).some((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? anyFileContains(full, needle) : readFileSync(full, 'utf8').includes(needle);
  });
}

/** How many pushes the fake received from `token`, refused or not. */
function pushCalls(fake: FakeServer, token: string): number {
  return fake.requests.filter(
    (request) => request.method === 'POST' && request.path.endsWith('/sync/commits') && request.token === token,
  ).length;
}

/** Sets the open request's intA to `value` and saves, which commits (and pushes, for an editor). */
async function saveIntA(page: Page, value: string): Promise<void> {
  await setMonacoText(page, 'Request envelope XML', calculatorEnvelope(value));
  await expect(page.getByTestId('editor-tab-dirty')).toHaveCount(1, { timeout: 10_000 });
  await saveAll(page);
}

/** In the open resolver, keeps this machine's side of every row; the resolver closes itself after the last. */
async function keepMineForAll(page: Page): Promise<void> {
  const resolver = page.getByTestId('conflict-resolver');
  const rows = resolver.getByTestId('conflict-resolver-row');
  for (let remaining = await rows.count(); remaining > 0; remaining -= 1) {
    await rows.first().getByTestId('conflict-resolver-mine').click();
    if (remaining > 1) {
      await expect(rows).toHaveCount(remaining - 1, { timeout: SYNC_TIMEOUT });
    }
  }
  await expect(resolver).toBeHidden({ timeout: SYNC_TIMEOUT });
}

/**
 * Wirebench Server sync (server-sync §11, e2e) against the in-memory fake server, with no git on any
 * profile. Each test names the success criterion (§13) it walks through.
 */
test.describe('server sync', () => {
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

  test('a teammate opens a shared workspace as a viewer, cannot push, and pushes once promoted', async () => {
    test.setTimeout(240_000);
    soap = await startTestSoapServer({ fixture: 'calculator' });
    const server = await startFakeServer({
      capabilities: SYNC_ONLY,
      users: [ALICE, BOB],
      teams: [{ name: TEAM, members: { [ALICE.email]: 'member', [BOB.email]: 'member' } }],
    });
    fake = server;
    const edited = '5555';

    // --- Alice signs in and shares a new workspace to the team (criterion 2) --------------------
    const alice = await profiles.launch({ extraEnv: NO_GIT });
    await signIn(alice.window, server.url, ALICE);
    await createProjectWithCalculator(alice.window, soap);
    await saveAll(alice.window);
    await shareToTeam(alice.window, TEAM);
    const workspaceId = server.workspaceId('Workspace 1');
    await expect
      .poll(() => server.subjects(workspaceId), { timeout: SYNC_TIMEOUT })
      .toContain('Share workspace Workspace 1');

    // --- Bob opens it as a viewer, edits and saves: the commit stays here (criterion 3) ---------
    const bob = await profiles.launch({ extraEnv: NO_GIT });
    await signIn(bob.window, server.url, BOB);
    await openTeamWorkspace(bob.window, 'Workspace 1');
    await waitForSync(bob.window, 'clean');
    await expect(syncBadge(bob.window)).toContainText('Viewer');
    const bobToken = server.lastToken(BOB.email);

    await expandExplorer(bob.window, 'Request 1');
    await openFirstRequest(bob.window);
    await saveIntA(bob.window, edited);
    await waitForSync(bob.window, 'ahead');
    await expect(syncBadge(bob.window)).toContainText('Viewer');

    let panel = await openSyncPanel(bob.window);
    await expect(panel.getByTestId('sync-push')).toBeDisabled();
    await expect(panel.getByTestId('sync-viewer-note')).toHaveText(VIEWER_REASON);
    await expect(panel.getByLabel('Push on save')).toBeDisabled();
    await closeSyncPanel(bob.window);

    // A manual push from the palette is refused on this machine, without a request.
    await pushNow(bob.window);
    panel = await openSyncPanel(bob.window);
    await expect(panel.getByTestId('sync-error-notice')).toContainText('viewer access', { timeout: 20_000 });
    await closeSyncPanel(bob.window);
    await waitForSync(bob.window, 'ahead');
    expect(pushCalls(server, bobToken)).toBe(0);
    expect(server.headContains(workspaceId, intA(edited))).toBe(false);

    // --- Promoted to editor: the next fetch drops Viewer and pushes the waiting commit by itself --
    server.setRole(workspaceId, BOB.email, 'editor');
    await runCommand(bob.window, 'Sync: Fetch');
    await expect(syncBadge(bob.window)).not.toContainText('Viewer', { timeout: SYNC_TIMEOUT });
    await waitForSync(bob.window, 'clean');
    await expect.poll(() => server.headContains(workspaceId, intA(edited)), { timeout: SYNC_TIMEOUT }).toBe(true);
    expect(pushCalls(server, bobToken)).toBeGreaterThan(0);

    // --- Alice pulls Bob's push ---------------------------------------------------------------
    await pullNow(alice.window);
    await waitForSync(alice.window, 'clean');
    await expect
      .poll(() => anyFileContains(sharedTreeDir(alice.userDataDir), intA(edited)), { timeout: SYNC_TIMEOUT })
      .toBe(true);
  });

  test("a teammate's commit on the server conflicts; the resolver keeps mine, then theirs, and each result pushes", async () => {
    test.setTimeout(240_000);
    soap = await startTestSoapServer({ fixture: 'calculator' });
    const server = await startFakeServer({
      capabilities: SYNC_ONLY,
      users: [ALICE, BOB],
      teams: [{ name: TEAM, members: { [ALICE.email]: 'member', [BOB.email]: 'member' } }],
    });
    fake = server;
    const base = '5555';

    const alice = await profiles.launch({ extraEnv: NO_GIT });
    const page = alice.window;
    await signIn(page, server.url, ALICE);
    await createProjectWithCalculator(page, soap);
    await saveAll(page);
    await shareToTeam(page, TEAM);
    const workspaceId = server.workspaceId('Workspace 1');
    server.setRole(workspaceId, BOB.email, 'editor');

    // A known value first, so the teammate's edit below touches exactly this request.
    await expandExplorer(page, 'Request 1');
    await openFirstRequest(page);
    await saveIntA(page, base);
    await waitForSync(page, 'clean');
    await expect.poll(() => server.headContains(workspaceId, intA(base)), { timeout: SYNC_TIMEOUT }).toBe(true);

    // --- Round 1: Bob changes intA on the server, Alice saves another value, keeps hers --------
    server.commitAs(workspaceId, BOB.email, 'Set intA to 1111', (_path, content) =>
      content.replace(intA(base), intA('1111')),
    );
    await saveIntA(page, '2222');
    await awaitConflict(page);
    await openConflictResolver(page);
    await keepMineForAll(page);
    await expect.poll(() => envelopeText(page), { timeout: 20_000 }).toContain(intA('2222'));
    await pushNow(page);
    await waitForSync(page, 'clean');
    await expect.poll(() => server.headContains(workspaceId, intA('2222')), { timeout: SYNC_TIMEOUT }).toBe(true);
    expect(server.headContains(workspaceId, intA('1111'))).toBe(false);
    expect(server.headContains(workspaceId, '<<<<<<<')).toBe(false);

    // --- Round 2: the same collision, and this time Alice keeps Bob's value --------------------
    server.commitAs(workspaceId, BOB.email, 'Set intA to 3333', (_path, content) =>
      content.replace(intA('2222'), intA('3333')),
    );
    await saveIntA(page, '4444');
    await awaitConflict(page);
    await openConflictResolver(page);
    await keepTheirsForAll(page);
    await expect.poll(() => envelopeText(page), { timeout: 20_000 }).toContain(intA('3333'));
    expect(await envelopeText(page)).not.toContain('<<<<<<<');
    await pushNow(page);
    await waitForSync(page, 'clean');
    await expect.poll(() => server.headContains(workspaceId, intA('3333')), { timeout: SYNC_TIMEOUT }).toBe(true);
    expect(server.headContains(workspaceId, intA('4444'))).toBe(false);
    expect(anyFileContains(sharedTreeDir(alice.userDataDir), '<<<<<<<')).toBe(false);
    expect(server.subjects(workspaceId)).toContain('Set intA to 3333');
  });

  test('an empty server workspace stays hidden until an editor shares into it, then opens for the team', async () => {
    test.setTimeout(180_000);
    const server = await startFakeServer({
      capabilities: SYNC_ONLY,
      users: [ALICE, BOB],
      teams: [
        {
          name: TEAM,
          members: { [ALICE.email]: 'member', [BOB.email]: 'member' },
          workspaces: [{ name: 'Staging' }],
        },
      ],
    });
    fake = server;
    const stagingId = server.workspaceId('Staging');

    // --- Bob sees nothing to open: Staging has no commits (O1) ---------------------------------
    const bob = await profiles.launch({ extraEnv: NO_GIT });
    await signIn(bob.window, server.url, BOB);
    const dialog = await openTeamDialog(bob.window);
    await expect(dialog.getByTestId('open-team-workspace-empty')).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByTestId('team-workspace-row')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();

    // --- Alice, an editor there, shares a local workspace into it; it takes Staging's name -----
    server.setRole(stagingId, ALICE.email, 'editor');
    const alice = await profiles.launch({ extraEnv: NO_GIT });
    await signIn(alice.window, server.url, ALICE);
    await createWorkspace(alice.window, 'Local draft');
    await shareToTeam(alice.window, TEAM, { existing: 'Staging' });
    await expect(alice.window.getByTestId('title-bar')).toContainText('Staging');
    await expect.poll(() => server.subjects(stagingId).length, { timeout: SYNC_TIMEOUT }).toBeGreaterThan(0);
    expect(server.headFiles(stagingId).has('workspace.yaml')).toBe(true);

    // --- Now Bob can open it, as a viewer (Staging's default role) -----------------------------
    await openTeamWorkspace(bob.window, 'Staging');
    await waitForSync(bob.window, 'clean');
    await expect(syncBadge(bob.window)).toContainText('Viewer');
  });

  test('removed access and a revoked token stop polling and show why; signing in again resumes', async () => {
    test.setTimeout(180_000);
    const server = await startFakeServer({
      capabilities: SYNC_ONLY,
      users: [ALICE],
      teams: [{ name: TEAM, members: { [ALICE.email]: 'member' } }],
    });
    fake = server;

    const alice = await profiles.launch({ extraEnv: NO_GIT });
    const page = alice.window;
    await signIn(page, server.url, ALICE);
    await createWorkspace(page);
    await shareToTeam(page, TEAM);
    const token = server.lastToken(ALICE.email);

    // Auto-fetch every 2 s, set from the Sync panel, so the timer is visible within the test.
    let panel = await openSyncPanel(page);
    const autoFetch = panel.getByLabel('Auto-fetch every N seconds');
    await autoFetch.fill('2');
    await autoFetch.press('Enter');
    await closeSyncPanel(page);
    const before = headCalls(server, token);
    await expect.poll(() => headCalls(server, token), { timeout: 20_000 }).toBeGreaterThanOrEqual(before + 2);

    // --- Access removed: No access, and the timer stops (criterion 6) --------------------------
    server.setTeamRole(TEAM, ALICE.email, undefined);
    await expect(syncBadge(page)).toContainText('No access', { timeout: 20_000 });
    await waitForSync(page, 'error');
    const afterRemoval = headCalls(server, token);
    await page.waitForTimeout(7_000);
    expect(headCalls(server, token)).toBe(afterRemoval);

    // --- Access back, but the token revoked: a manual fetch shows Sign in, and nothing polls ----
    server.setTeamRole(TEAM, ALICE.email, 'member');
    server.revoke(token);
    await runCommand(page, 'Sync: Fetch');
    await expect(syncBadge(page)).toContainText('Sign in', { timeout: 20_000 });
    const afterRevoke = headCalls(server, token);
    await page.waitForTimeout(7_000);
    expect(headCalls(server, token)).toBe(afterRevoke);

    // --- Sign in from the Sync panel: the dialog knows the server; sync resumes ----------------
    panel = await openSyncPanel(page);
    await expect(panel.getByTestId('sync-error-notice')).toBeVisible();
    await panel.getByTestId('sync-sign-in').click();
    await expect(panel).toBeHidden();
    const dialog = page.getByTestId('sign-in-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('sign-in-url')).toHaveValue(server.url);
    await completeSignIn(page, ALICE);
    const renewed = server.lastToken(ALICE.email);
    expect(renewed).not.toBe(token);
    await waitForSync(page, 'clean');
    await expect(syncBadge(page)).not.toContainText('Sign in');
    await expect.poll(() => headCalls(server, renewed), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  });
});
