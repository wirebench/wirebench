import { expect, test } from '@playwright/test';
import { startSshFixture, type SshFixture } from '@wirebench/ssh/test-helpers';
import { startFakeServer, type FakeServer, type FakeUser } from '../helpers/fake-server.js';
import { runCommand } from '../helpers/palette.js';
import { createWorkspace } from '../helpers/project.js';
import { shareToTeam, signIn } from '../helpers/server.js';
import { addPasswordHost, trustHostKey } from '../helpers/ssh-host.js';
import { SyncProfiles, SYNC_TIMEOUT } from '../helpers/sync.js';

/**
 * Team session logs (#430) against the fake server: once the workspace's admin turns recording on, an SSH
 * session on its hosts is logged whatever the local switch says, streams its masked text to the server
 * while it runs, and the Team session logs dialog reads it back.
 */

const ALICE: FakeUser = { email: 'alice@example.com', password: 'correct horse battery', displayName: 'Alice' };
const TEAM = 'Ops';
/** Main's git lookup probes only this path when the override is set: a server share needs no git. */
const NO_GIT = { WIREBENCH_E2E_GIT_PATH: '/nonexistent/git' };

test.describe('team session logs', () => {
  let profiles = new SyncProfiles();
  let fake: FakeServer | undefined;
  let fixture: SshFixture | undefined;

  test.afterEach(async () => {
    const current = profiles;
    profiles = new SyncProfiles();
    try {
      await current.dispose();
    } finally {
      await fixture?.close();
      await fake?.close();
      fixture = undefined;
      fake = undefined;
    }
  });

  test('a recorded session streams to the server and reads back in the team dialog', async () => {
    test.setTimeout(240_000);
    fake = await startFakeServer({
      users: [ALICE],
      teams: [{ name: TEAM, members: { [ALICE.email]: 'admin' } }],
      sessionLogs: true,
    });
    fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' } });

    const alice = await profiles.launch({ extraEnv: NO_GIT });
    const page = alice.window;
    await signIn(page, fake.url, ALICE);
    await createWorkspace(page);
    await shareToTeam(page, TEAM);
    await expect(page.getByTestId('sync-live-dot')).toHaveAttribute('data-state', 'connected', {
      timeout: SYNC_TIMEOUT,
    });
    fake.setRecordSessionLogs(fake.workspaceId('Workspace 1'), true);

    await addPasswordHost(page, fixture, { name: 'box' });
    // The team records: the host's own switch shows on and cannot be turned off.
    await page.getByTestId('host-row-box').click();
    await page.getByTestId('rail-host-details').click();
    const details = page.getByTestId('host-details');
    await expect(details.getByText('recorded by your team')).toBeVisible({ timeout: SYNC_TIMEOUT });
    await expect(details.getByRole('switch', { name: 'Log sessions' })).toBeDisabled();
    await page.keyboard.press('Escape');

    await page.getByTestId('host-row-box').dblclick();
    await trustHostKey(page, fixture);
    const editor = page.getByTestId('editor-area');
    await expect(editor.getByLabel('connected', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(editor.getByTestId('recording-mark')).toBeVisible();
    const terminal = page.getByTestId('ssh-terminal');
    await terminal.click();
    await page.keyboard.type('echo team-log-marker');
    // The fixture echoes bytes as they are; a line feed ends the line, so the log writes it.
    await page.keyboard.press('Control+J');
    await expect(terminal).toContainText('echo team-log-marker', { timeout: 30_000 });

    // Streamed while the session is still open.
    await expect
      .poll(
        () =>
          fake
            ?.sessionLogs()
            .map((log) => log.text)
            .join(''),
        { timeout: 30_000 },
      )
      .toContain('team-log-marker');
    expect(fake.sessionLogs()[0]).toMatchObject({ hostName: 'box', email: ALICE.email, ended: undefined });

    // Out of the terminal first: there the shortcut goes to the shell.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await runCommand(page, 'Terminal: Team Session Logs');
    const dialog = page.getByTestId('team-session-logs-dialog');
    await expect(dialog).toBeVisible();
    const row = dialog.getByRole('button', { name: /box/ });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByLabel('Still running')).toBeVisible();
    await row.click();
    await expect(dialog.getByTestId('team-log-text')).toContainText('team-log-marker', { timeout: 20_000 });
  });
});
