import { expect, test } from '@playwright/test';
import { ADA, createBareRemote, remoteLog, runGit, treeHead } from '../helpers/git-remote.js';
import { createProjectWithCalculator, saveAll } from '../helpers/project.js';
import {
  closeManageWorkspaces,
  pushNow,
  sharedTreeDir,
  shareWorkspace,
  SyncProfiles,
  SYNC_TIMEOUT,
  waitForSync,
} from '../helpers/sync.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

/**
 * A machine with no git identity: the first commit a shared workspace makes — the share's own —
 * stops on the identity dialog, and the name and email entered there go into the tree's own git
 * config, so the commit that asked (and every later one) is recorded under them.
 */
test.describe('shared workspace identity', () => {
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

  test('the first commit asks for an identity, and the commit is pushed under it', async () => {
    test.setTimeout(180_000);
    server = await startTestSoapServer({ fixture: 'calculator' });
    const remote = await createBareRemote();
    profiles.track(remote.dir);

    // `null`: a global config with no identity, and no guessing one from the host name.
    const launched = await profiles.launch({ identity: null });
    const page = launched.window;
    await createProjectWithCalculator(page, server);
    await saveAll(page);

    await shareWorkspace(page, remote.url, { waitForState: null });
    const dialog = page.getByTestId('sync-identity-dialog');
    await expect(dialog).toBeVisible({ timeout: SYNC_TIMEOUT });
    // Nothing could be committed, so nothing reached the remote.
    expect(remoteLog(remote.dir)).toEqual([]);

    await dialog.getByTestId('sync-identity-name').fill(ADA.name);
    await dialog.getByTestId('sync-identity-email').fill(ADA.email);
    await dialog.getByTestId('sync-identity-submit').click();
    await expect(dialog).toBeHidden({ timeout: SYNC_TIMEOUT });
    await closeManageWorkspaces(page);

    // Setting the identity retried the share's commit, under the tree's own config.
    const tree = sharedTreeDir(launched.userDataDir);
    await expect.poll(() => treeHead(tree), { timeout: SYNC_TIMEOUT }).not.toBeUndefined();
    expect(runGit(['-C', tree, 'config', '--local', 'user.name'], null).trim()).toBe(ADA.name);
    expect(runGit(['-C', tree, 'config', '--local', 'user.email'], null).trim()).toBe(ADA.email);

    await pushNow(page);
    await waitForSync(page, 'clean');
    await expect.poll(() => remoteLog(remote.dir, '%an'), { timeout: SYNC_TIMEOUT }).toContain(ADA.name);
    expect(remoteLog(remote.dir)).toContain('Share workspace Workspace 1');
    expect(remoteLog(remote.dir, '%ae')).toContain(ADA.email);
  });
});
