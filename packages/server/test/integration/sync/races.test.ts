import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SyncChange, SyncLogEntry, SyncPushCommit, SyncPushResponse } from '@wirebench/engine';
import { describeDb } from '../../helpers/database.js';
import type { IdentityHarness, SignedInUser } from '../../helpers/identity.js';
import { syncFixture, type SyncFixture } from '../../helpers/sync.js';
import { call } from '../../helpers/teams.js';

const AT = '2026-09-24T12:00:00.000Z';
const text = (path: string, content: string): SyncChange => ({ path, encoding: 'utf8', content });
const commit = (subject: string, changes: SyncChange[]): SyncPushCommit => ({ subject, at: AT, changes });

/** Holds the workspace lock until `release()`, so requests queue behind it in a known order. */
function holdLock(
  h: IdentityHarness,
  workspaceId: string,
): { readonly done: Promise<void>; readonly release: () => void } {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { done: h.repos.withLock(workspaceId, () => gate), release: () => open() };
}

describeDb('server-sync races (§3.2, R11)', () => {
  let f: SyncFixture;
  beforeEach(async () => {
    f = await syncFixture();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await f.h.close();
  });

  const url = (route: string): string => `/workspaces/${f.workspaceId}/sync/${route}`;
  const push = (as: SignedInUser, parent: string | null, commits: SyncPushCommit[]) =>
    call<SyncPushResponse>(f.h, as, 'POST', url('commits'), { parent, commits });
  const reads = (headId: string): string[] => ['head', 'snapshot', `changes?to=${headId}`, 'log'];

  it('two concurrent pushes serialise under the lock: the first lands, the second is 409 with no head', async () => {
    const lock = holdLock(f.h, f.workspaceId);
    const queued = vi.spyOn(f.h.repos, 'withLock');
    const one = push(f.editor, null, [commit('From editor', [text('workspace.yaml', 'editor\n')])]);
    await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(1));
    const two = push(f.admin, null, [commit('From admin', [text('workspace.yaml', 'admin\n')])]);
    await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(2));
    lock.release();
    await lock.done;
    const [first, second] = await Promise.all([one, two]);
    expect(first.status).toBe(201);
    expect(second).toEqual({
      status: 409,
      body: { code: 'sync-push-rejected', message: expect.any(String) as string },
    });
    const log = await call<SyncLogEntry[]>(f.h, f.viewer, 'GET', url('log'));
    expect(log.body.map((entry) => entry.subject)).toEqual(['From editor']);
  });

  it('a push racing a workspace delete answers 404, never 500', async () => {
    const lock = holdLock(f.h, f.workspaceId);
    const queued = vi.spyOn(f.h.repos, 'withLock');
    const deleting = call(f.h, f.admin, 'DELETE', `/workspaces/${f.workspaceId}`);
    await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(1)); // the delete is next in line
    // The row still exists, so the push's guard passes; it queues behind the delete.
    const pushing = push(f.editor, null, [commit('Too late', [text('workspace.yaml', 'x\n')])]);
    await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(2));
    lock.release();
    await lock.done;
    expect((await deleting).status).toBe(204);
    expect(await pushing).toMatchObject({ status: 404, body: { code: 'teams-workspace-not-found' } });
    expect(await f.h.repos.exists(f.workspaceId)).toBe(false);
  });

  it('every read after a delete answers 404', async () => {
    const first = await push(f.editor, null, [commit('One', [text('workspace.yaml', 'a\n')])]);
    expect((await call(f.h, f.admin, 'DELETE', `/workspaces/${f.workspaceId}`)).status).toBe(204);
    for (const route of reads(first.body.head)) {
      expect(await call(f.h, f.viewer, 'GET', url(route))).toMatchObject({
        status: 404,
        body: { code: 'teams-workspace-not-found' },
      });
    }
  });

  it('a read or a push that finds the repository gone while the row remains answers 404, never 500', async () => {
    const first = await push(f.editor, null, [commit('One', [text('workspace.yaml', 'a\n')])]);
    // What a delete looks like between its guard and its row delete, or a repository lost on disk.
    await f.h.repos.withLock(f.workspaceId, () => f.h.repos.remove(f.workspaceId));
    for (const route of reads(first.body.head)) {
      expect(await call(f.h, f.viewer, 'GET', url(route))).toMatchObject({
        status: 404,
        body: { code: 'teams-workspace-not-found' },
      });
    }
    expect(await push(f.editor, first.body.head, [commit('Two', [text('workspace.yaml', 'b\n')])])).toMatchObject({
      status: 404,
      body: { code: 'teams-workspace-not-found' },
    });
  });
});
