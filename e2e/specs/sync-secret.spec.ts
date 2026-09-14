import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from '@playwright/test';
import { createBareRemote, remoteContains, remoteHead, runGit, treeHead } from '../helpers/git-remote.js';
import { expandExplorer, openFirstRequest, saveAll } from '../helpers/project.js';
import {
  joinSharedWorkspace,
  pullNow,
  sharedProjectDir,
  sharedTreeDir,
  startSharedWorkspace,
  SyncProfiles,
  SYNC_TIMEOUT,
} from '../helpers/sync.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

/** Every file under `dir`, keyed by its path relative to `dir`, with its bytes as base64. */
function snapshotFiles(dir: string, root = dir, out = new Map<string, string>()): Map<string, string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      snapshotFiles(full, root, out);
    } else {
      out.set(relative(root, full), readFileSync(full).toString('base64'));
    }
  }
  return out;
}

/**
 * Secret refs are shared, values are not: A sets a Basic-auth password and pushes; B pulls and
 * sees "Not on this machine". Entering the value on B stores it under the same ref, so even after
 * B saves, the shared tree has nothing to commit — and B's send then authenticates.
 */
test.describe('shared workspaces: secrets', () => {
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

  test('a secret set in one profile is "Not on this machine" in the other until entered there', async () => {
    test.setTimeout(180_000);
    const PASSWORD = 'pass';
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    const remote = await createBareRemote();
    profiles.track(remote.dir);

    const a = await profiles.launch();
    await startSharedWorkspace(a.window, server, remote);
    const b = await profiles.launch();
    await joinSharedWorkspace(b.window, remote.url);

    // --- A: Basic auth on the first request, against the fixture's /auth/basic ---------------
    const pageA = a.window;
    await expandExplorer(pageA, 'Request 1');
    await openFirstRequest(pageA);
    await pageA.getByTestId('request-endpoint').fill(`${server.url}/auth/basic`);
    await pageA.getByRole('tablist', { name: 'Request inspectors' }).getByRole('tab', { name: 'Auth' }).click();
    const panelA = pageA.getByTestId('inspector-panel-request');
    await pageA.getByTestId('auth-inherit').uncheck();
    await panelA.getByLabel('Authentication type').selectOption('basic');
    await panelA.getByLabel('Username').fill('user');
    await panelA.getByRole('button', { name: 'Set…' }).click();
    await panelA.getByPlaceholder('Enter password').fill(PASSWORD);
    await panelA.getByRole('button', { name: 'Save' }).click();
    await expect(panelA.getByLabel('Password')).toHaveText('••••••••');
    await saveAll(pageA);
    await expect.poll(() => remoteContains(remote.dir, '/auth/basic'), { timeout: SYNC_TIMEOUT }).toBe(true);
    await expect.poll(() => remoteContains(remote.dir, 'passwordRef'), { timeout: SYNC_TIMEOUT }).toBe(true);

    // --- B pulls and opens the request: the ref arrived, the value did not ---------------------
    const pageB = b.window;
    const treeB = sharedTreeDir(b.userDataDir);
    await pullNow(pageB);
    await expect.poll(() => treeHead(treeB), { timeout: SYNC_TIMEOUT }).toBe(remoteHead(remote.dir));
    await expandExplorer(pageB, 'Request 1');
    await openFirstRequest(pageB);
    await expect(pageB.getByTestId('request-endpoint')).toHaveValue(/\/auth\/basic$/, { timeout: 20_000 });
    await pageB.getByRole('tablist', { name: 'Request inspectors' }).getByRole('tab', { name: 'Auth' }).click();
    const panelB = pageB.getByTestId('inspector-panel-request');
    await expect(panelB.getByTestId('secret-missing')).toHaveText('Not on this machine', { timeout: 20_000 });

    // Sending now fails in words that say where to act.
    await pageB.getByTestId('request-send').click();
    await expect(
      pageB
        .getByText('The password for "user" is not on this machine — enter it in the authentication settings.')
        .first(),
    ).toBeVisible({ timeout: 20_000 });

    // --- B enters the value: same ref, so saving leaves the shared tree with nothing to commit --
    const headBefore = treeHead(treeB);
    const projectDir = sharedProjectDir(b.userDataDir);
    const bytesBefore = snapshotFiles(projectDir);
    await panelB.getByRole('button', { name: 'Enter…' }).click();
    await panelB.getByPlaceholder('Enter password').fill(PASSWORD);
    await panelB.getByRole('button', { name: 'Save' }).click();
    await expect(panelB.getByLabel('Password')).toHaveText('••••••••');
    await expect(panelB.getByTestId('secret-missing')).toHaveCount(0);

    await saveAll(pageB);
    expect(runGit(['-C', treeB, 'status', '--porcelain', '--untracked-files=all'])).toBe('');
    expect(treeHead(treeB)).toBe(headBefore);
    expect([...snapshotFiles(projectDir)]).toEqual([...bytesBefore]);

    await pageB.getByTestId('request-send').click();
    await expect(pageB.getByTestId('response-status')).toContainText('200', { timeout: 20_000 });
  });
});
