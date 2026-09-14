import { expect, test, type Page } from '@playwright/test';
import { environmentRow, openEnvironment, openEnvironmentsView, setVariable } from '../helpers/environments.js';
import {
  createBareRemote,
  remoteContains,
  remoteFiles,
  remoteHead,
  remoteLog,
  treeHead,
} from '../helpers/git-remote.js';
import {
  addActiveEnvironment,
  ENVIRONMENT_NAME,
  joinSharedWorkspace,
  pullNow,
  sharedTreeDir,
  startSharedWorkspace,
  SyncProfiles,
  SYNC_TIMEOUT,
  waitForSync,
} from '../helpers/sync.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

/** The values of every variable row on the open environment page. */
async function variableValues(page: Page): Promise<string[]> {
  const inputs = page.getByTestId('env-variable-value');
  const values: string[] = [];
  for (let index = 0, count = await inputs.count(); index < count; index += 1) {
    values.push(await inputs.nth(index).inputValue());
  }
  return values;
}

/**
 * An environment edit travels by pull: A changes one variable of a shared environment, which is
 * exactly one new commit on the remote naming that environment; B pulls and sees the value, with
 * no changed-on-disk banner for a change the pull itself wrote.
 */
test.describe('shared workspaces: pull', () => {
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

  test('an environment edited in one profile is one commit, and arrives in the other by pull', async () => {
    test.setTimeout(180_000);
    const BEFORE = 'eu-west-before';
    const AFTER = 'eu-west-after-7731';
    server = await startTestSoapServer({ fixture: 'calculator' });
    const remote = await createBareRemote();
    profiles.track(remote.dir);

    const a = await profiles.launch();
    await startSharedWorkspace(a.window, server, remote, {
      beforeShare: (page) => addActiveEnvironment(page, 'region', BEFORE),
    });
    const b = await profiles.launch();
    await joinSharedWorkspace(b.window, remote.url);

    const environmentFiles = remoteFiles(remote.dir).filter((file) => /^environments\/[^/]+\.yaml$/.test(file));
    expect(environmentFiles).toHaveLength(1);
    const environmentSlug = (environmentFiles[0] as string).replace(/^environments\/|\.yaml$/g, '');
    await waitForSync(a.window, 'clean');
    const commitsBefore = remoteLog(remote.dir);

    // --- A changes the variable's value: one mutation, one commit, one push -------------------
    await openEnvironmentsView(a.window);
    await openEnvironment(a.window, ENVIRONMENT_NAME);
    await setVariable(a.window, 'region', AFTER);
    await expect.poll(() => remoteContains(remote.dir, AFTER), { timeout: SYNC_TIMEOUT }).toBe(true);
    await waitForSync(a.window, 'clean');
    const commitsAfter = remoteLog(remote.dir);
    expect(commitsAfter.slice(1)).toEqual(commitsBefore);
    expect(commitsAfter[0]).toContain(`environment ${environmentSlug}`);

    // --- B pulls: the value shows, with no changed-on-disk banner -----------------------------
    await pullNow(b.window);
    await expect
      .poll(() => treeHead(sharedTreeDir(b.userDataDir)), { timeout: SYNC_TIMEOUT })
      .toBe(remoteHead(remote.dir));
    await waitForSync(b.window, 'clean');
    await openEnvironmentsView(b.window);
    await expect(environmentRow(b.window, ENVIRONMENT_NAME)).toBeVisible({ timeout: 20_000 });
    await openEnvironment(b.window, ENVIRONMENT_NAME);
    await expect.poll(() => variableValues(b.window), { timeout: 20_000 }).toContain(AFTER);
    expect(await variableValues(b.window)).not.toContain(BEFORE);
    await expect(b.window.locator('[data-testid^="changed-on-disk-banner"]')).toHaveCount(0);
  });
});
