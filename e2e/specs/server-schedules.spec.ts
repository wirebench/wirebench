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
 * Scheduled runs in the desktop (#517) against the fake server: a workspace admin schedules a project
 * from its row, runs it now, sees the failing run arrive live — red dot and count in the Explorer — and
 * opens the run's results.
 */
test.describe('scheduled runs', () => {
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

  test('schedule a project, run it now, watch it fail live, and open the run', async () => {
    test.setTimeout(180_000);
    const server = await startFakeServer({
      users: [ALICE],
      teams: [{ name: TEAM, members: { [ALICE.email]: 'admin' } }],
      schedules: true,
    });
    fake = server;

    // --- Alice shares a workspace on the server; the Schedules node appears, empty ----------------
    const alice = await profiles.launch({ extraEnv: NO_GIT });
    const page = alice.window;
    await signIn(page, server.url, ALICE);
    await createWorkspace(page);
    await createProject(page, 'Demo');
    await shareToTeam(page, TEAM);
    await expect(page.getByTestId('sync-live-dot')).toHaveAttribute('data-state', 'connected', {
      timeout: SYNC_TIMEOUT,
    });
    await expect(page.getByTestId('schedules-row')).toBeVisible({ timeout: SYNC_TIMEOUT });

    // --- Schedule… on the project row fills in the project; saving opens the schedule's tab ---------
    await page.getByTestId('explorer-project-row').filter({ hasText: 'Demo' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Schedule…' }).click();
    const dialog = page.getByTestId('schedule-dialog');
    await dialog.getByTestId('schedule-name').fill('Smoke');
    await dialog.getByTestId('schedule-when').fill('*/5 * * * *');
    await dialog.getByTestId('schedule-save').click();
    await expect(dialog).toBeHidden();
    const row = page.getByTestId('schedule-row').filter({ hasText: 'Smoke' });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('schedule-dot')).toHaveAttribute('data-state', 'never');
    const tab = page.getByTestId('schedule-tab');
    await expect(tab.getByTestId('schedule-runs-empty')).toBeVisible({ timeout: SYNC_TIMEOUT });
    await expect(tab.getByTestId('schedule-when-text')).toContainText('Every 5 minutes');

    // --- Run now: the failed run arrives over /live; the dot turns red with its count ---------------
    await tab.getByTestId('schedule-run-now').click();
    const run = tab.getByTestId('schedule-run-row');
    await expect(run).toHaveCount(1, { timeout: LIVE_TIMEOUT });
    await expect(run).toHaveAttribute('data-status', 'failed', { timeout: LIVE_TIMEOUT });
    await expect(row.getByTestId('schedule-dot')).toHaveAttribute('data-state', 'failing', { timeout: LIVE_TIMEOUT });
    await expect(row.getByTestId('schedule-failing')).toHaveText('1');

    // --- Open the run: its request's result, as the Runner shows it ---------------------------------
    await run.click();
    await expect(tab.getByTestId('schedule-run-status')).toHaveText('failed');
    const detail = tab.getByTestId('schedule-run-detail');
    await expect(detail).toContainText('Demo/check.yaml');
    await expect(detail).toContainText('expected 200, actual 500');

    // --- A passing run clears the dot ---------------------------------------------------------------
    server.setScheduleOutcome('passed');
    await tab.getByTestId('schedule-run-now').click();
    await expect(run).toHaveCount(2, { timeout: LIVE_TIMEOUT });
    await expect(run.first()).toHaveAttribute('data-status', 'passed', { timeout: LIVE_TIMEOUT });
    await expect(row.getByTestId('schedule-dot')).toHaveAttribute('data-state', 'ok', { timeout: LIVE_TIMEOUT });
    await expect(row.getByTestId('schedule-failing')).toHaveCount(0);
  });
});
