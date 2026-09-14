import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createBareRemote, remoteContains, remoteFiles, remoteHead, treeHead } from '../helpers/git-remote.js';
import {
  CONFLICT_MINE,
  CONFLICT_THEIRS,
  envelopeText,
  joinSharedWorkspace,
  keepTheirsForAll,
  openConflictResolver,
  produceRequestConflict,
  pullNow,
  pushNow,
  sharedTreeDir,
  startSharedWorkspace,
  SyncProfiles,
  SYNC_TIMEOUT,
  waitForSync,
} from '../helpers/sync.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

/** Whether any file under `dir` (skipping `.git`) contains `needle`. */
function anyFileContains(dir: string, needle: string): boolean {
  return readdirSync(dir).some((name) => {
    if (name === '.git') {
      return false;
    }
    const full = join(dir, name);
    return statSync(full).isDirectory() ? anyFileContains(full, needle) : readFileSync(full, 'utf8').includes(needle);
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The same request edited in two profiles: A pushes first, B's save conflicts. The resolver names
 * the request; keeping theirs gives B A's text with no markers, B pushes the merge, and A's next
 * pull lands on that same commit — both profiles converge on A's version.
 */
test.describe('shared workspaces: conflict', () => {
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

  test('a conflicting request edit is named in the resolver, and keeping theirs converges both profiles', async () => {
    test.setTimeout(180_000);
    const theirsLine = `<tem:intA>${CONFLICT_THEIRS}</tem:intA>`;
    const mineLine = `<tem:intA>${CONFLICT_MINE}</tem:intA>`;
    server = await startTestSoapServer({ fixture: 'calculator' });
    const remote = await createBareRemote();
    profiles.track(remote.dir);

    const a = await profiles.launch();
    await startSharedWorkspace(a.window, server, remote);
    const b = await profiles.launch();
    await joinSharedWorkspace(b.window, remote.url);

    await produceRequestConflict(a.window, b.window, remote.dir);
    await expect(b.window.getByTestId('sync-banner-conflicts')).toBeVisible();
    await expect(b.window.getByTestId('request-conflict-note')).toBeVisible({ timeout: 20_000 });

    // --- the resolver names the entity: `request: <slug>` -------------------------------------
    const requestSlugs = [
      ...new Set(
        remoteFiles(remote.dir)
          .map((file) => /\/operations\/[^/]+\/([^/]+)\.request\.yaml$/.exec(file)?.[1])
          .filter((slug): slug is string => slug !== undefined),
      ),
    ];
    expect(requestSlugs.length).toBeGreaterThan(0);
    const resolver = await openConflictResolver(b.window);
    const rows = resolver.getByTestId('conflict-resolver-row');
    const entityPattern = new RegExp(`request: (${requestSlugs.map(escapeRegExp).join('|')})`);
    const rowCount = await rows.count();
    for (let index = 0; index < rowCount; index += 1) {
      await expect(rows.nth(index)).toContainText(entityPattern);
    }

    // --- B keeps theirs: A's text, no markers, then B pushes the merge ------------------------
    await keepTheirsForAll(b.window);
    await expect.poll(() => envelopeText(b.window), { timeout: 20_000 }).toContain(theirsLine);
    const textB = await envelopeText(b.window);
    expect(textB).not.toContain(mineLine);
    expect(textB).not.toContain('<<<<<<<');
    await expect(b.window.getByTestId('request-conflict-note')).toHaveCount(0, { timeout: 20_000 });
    const treeB = sharedTreeDir(b.userDataDir);
    expect(anyFileContains(treeB, '<<<<<<<')).toBe(false);
    expect(anyFileContains(treeB, mineLine)).toBe(false);
    expect(anyFileContains(treeB, theirsLine)).toBe(true);

    await pushNow(b.window);
    await waitForSync(b.window, 'clean');
    await expect.poll(() => remoteHead(remote.dir), { timeout: SYNC_TIMEOUT }).toBe(treeHead(treeB));
    expect(remoteContains(remote.dir, mineLine)).toBe(false);
    expect(remoteContains(remote.dir, '<<<<<<<')).toBe(false);
    expect(remoteContains(remote.dir, theirsLine)).toBe(true);

    // --- A's next pull is clean and lands on the same commit ----------------------------------
    await pullNow(a.window);
    const treeA = sharedTreeDir(a.userDataDir);
    await expect.poll(() => treeHead(treeA), { timeout: SYNC_TIMEOUT }).toBe(remoteHead(remote.dir));
    await waitForSync(a.window, 'clean');
    await expect(a.window.getByTestId('request-conflict-note')).toHaveCount(0);
    await expect(a.window.getByTestId('sync-banner-conflicts')).toHaveCount(0);
    const textA = await envelopeText(a.window);
    expect(textA).toContain(theirsLine);
    expect(textA).not.toContain(mineLine);
    expect(anyFileContains(treeA, '<<<<<<<')).toBe(false);
    expect(anyFileContains(treeA, mineLine)).toBe(false);
  });
});
