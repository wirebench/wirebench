import { expect, test } from '@playwright/test';
import { formatTerminalShareInvite } from '@wirebench/engine';
import { startSshFixture, type SshFixture } from '@wirebench/ssh/test-helpers';
import { startFakeServer, type FakeServer, type FakeUser } from '../helpers/fake-server.js';
import { runCommand } from '../helpers/palette.js';
import { createWorkspace } from '../helpers/project.js';
import { openTeamWorkspace, shareToTeam, signIn } from '../helpers/server.js';
import { addPasswordHost, trustHostKey } from '../helpers/ssh-host.js';
import { SyncProfiles, SYNC_TIMEOUT } from '../helpers/sync.js';

/**
 * Live terminal sharing (#429) against the fake server's relay, with two app instances: Alice shares an SSH
 * session, Bob joins from the invite link, sees the screen, asks for control, types once Alice approves,
 * and sees the share end when she stops it, then closes the tab.
 */

const PASSWORD = 'correct horse battery';
const ALICE: FakeUser = { email: 'alice@example.com', password: PASSWORD, displayName: 'Alice' };
const BOB: FakeUser = { email: 'bob@example.com', password: PASSWORD, displayName: 'Bob' };
const TEAM = 'Ops';
const NO_GIT = { WIREBENCH_E2E_GIT_PATH: '/nonexistent/git' };

test.describe('terminal sharing', () => {
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

  test('a teammate joins by link, takes control on approval, and sees the share end', async () => {
    test.setTimeout(300_000);
    fake = await startFakeServer({
      users: [ALICE, BOB],
      teams: [{ name: TEAM, members: { [ALICE.email]: 'admin', [BOB.email]: 'member' } }],
      terminalShares: true,
    });
    fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' } });

    const alice = (await profiles.launch({ extraEnv: NO_GIT })).window;
    await signIn(alice, fake.url, ALICE);
    await createWorkspace(alice);
    await shareToTeam(alice, TEAM);
    const bob = (await profiles.launch({ extraEnv: NO_GIT })).window;
    await signIn(bob, fake.url, BOB);
    await openTeamWorkspace(bob, 'Workspace 1');

    await addPasswordHost(alice, fixture, { name: 'box' });
    await alice.getByTestId('host-row-box').dblclick();
    await trustHostKey(alice, fixture);
    const editor = alice.getByTestId('editor-area');
    await expect(editor.getByLabel('connected', { exact: true })).toBeVisible({ timeout: 30_000 });
    const terminal = alice.getByTestId('ssh-terminal');
    await terminal.click();
    await alice.keyboard.type('echo before');
    await alice.keyboard.press('Control+J');

    await terminal.click({ button: 'right' });
    await alice.getByTestId('terminal-menu').getByRole('menuitem', { name: 'Share session' }).click();
    const strip = alice.getByTestId('share-strip');
    await expect(strip).toContainText('nobody watching yet', { timeout: SYNC_TIMEOUT });
    await expect.poll(() => fake?.terminalShares().length).toBe(1);
    const invite = formatTerminalShareInvite({
      server: new URL(fake.url).origin,
      workspaceId: fake.workspaceId('Workspace 1'),
      shareId: fake.terminalShares()[0]!.id,
    });

    await runCommand(bob, 'Terminal: Join Shared Terminal');
    const join = bob.getByTestId('join-share-dialog');
    await join.getByLabel('Invite link').fill(invite);
    await expect(join.getByTestId('join-share-preview')).toContainText('Alice’s terminal on box', {
      timeout: SYNC_TIMEOUT,
    });
    await join.getByRole('button', { name: 'Join' }).click();
    const view = bob.getByTestId('share-view');
    await expect(view.getByTestId('share-view-terminal')).toContainText('echo before', { timeout: 20_000 });
    await expect(view.getByTestId('share-view-control')).toHaveText('View only');
    // Bob counts himself among those watching, as Alice's strip does (#690).
    await expect(view.getByTestId('share-view-watching')).toHaveText('1 watching');
    await expect(view.getByTestId('share-view-header')).toContainText('Bob (you)');
    await expect(strip).toContainText('1 watching');
    await expect(strip.getByTestId('share-viewer-Bob')).toBeVisible();

    // Output after joining arrives as it is printed.
    await terminal.click();
    await alice.keyboard.type('echo live');
    await alice.keyboard.press('Control+J');
    await expect(view.getByTestId('share-view-terminal')).toContainText('echo live', { timeout: 20_000 });

    await view.getByRole('button', { name: 'Request control' }).click();
    await expect(strip.getByTestId('share-request')).toContainText('Bob asks for control');
    await strip.getByRole('button', { name: 'Approve' }).click();
    await expect(view.getByTestId('share-view-control')).toHaveText('You have control');
    await view.getByTestId('share-view-terminal').click();
    await bob.keyboard.type('echo from-bob');
    await bob.keyboard.press('Control+J');
    await expect(terminal).toContainText('echo from-bob', { timeout: 20_000 });
    await expect(view.getByTestId('share-view-terminal')).toContainText('echo from-bob');

    await strip.getByRole('button', { name: 'Take back control' }).click();
    await expect(view.getByTestId('share-view-control')).toHaveText('View only');
    await strip.getByRole('button', { name: 'Stop sharing' }).click();
    await expect(view.getByTestId('share-view-ended')).toHaveText('The owner stopped sharing.');
    await expect(view.getByTestId('share-view-watching')).toBeHidden();
    await expect(view.getByTestId('share-view-header')).not.toContainText('Bob (you)');
    await expect(strip).toBeHidden();
    await expect.poll(() => fake?.terminalShares().length).toBe(0);
    await view.getByRole('button', { name: 'Close tab' }).click();
    await expect(view).toBeHidden();
  });
});
