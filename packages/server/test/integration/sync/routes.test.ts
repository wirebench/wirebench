import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  GitCli,
  type SyncChange,
  type SyncChangesResponse,
  type SyncHeadResponse,
  type SyncLogEntry,
  type SyncPushCommit,
  type SyncPushResponse,
  type SyncSnapshotResponse,
} from '@wirebench/engine';
import { describeDb } from '../../helpers/database.js';
import type { SignedInUser } from '../../helpers/identity.js';
import { syncFixture, type SyncFixture } from '../../helpers/sync.js';
import { call } from '../../helpers/teams.js';

const AT = '2026-09-24T12:00:00.000Z';
const text = (path: string, content: string): SyncChange => ({ path, encoding: 'utf8', content });
const commit = (subject: string, changes: SyncChange[]): SyncPushCommit => ({ subject, at: AT, changes });

describeDb('server-sync routes (§3.2)', () => {
  let f: SyncFixture;
  beforeEach(async () => {
    f = await syncFixture();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await f.h.close();
  });

  const url = (route: string): string => `/workspaces/${f.workspaceId}/sync/${route}`;
  const get = <T>(as: SignedInUser | undefined, route: string) => call<T>(f.h, as, 'GET', url(route));
  const push = (as: SignedInUser | undefined, parent: string | null, commits: SyncPushCommit[]) =>
    call<SyncPushResponse>(f.h, as, 'POST', url('commits'), { parent, commits });

  it('meta lists sync beside identity and teams', async () => {
    const meta = await call<{ capabilities: string[] }>(f.h, undefined, 'GET', '/meta');
    expect(meta.body.capabilities).toEqual(['identity', 'sync', 'teams']);
  });

  it("an empty workspace: a null head, no commits, an empty snapshot and log, and each caller's role", async () => {
    for (const [user, role] of [
      [f.viewer, 'viewer'],
      [f.editor, 'editor'],
      [f.admin, 'admin'],
    ] as const) {
      expect(await get(user, 'head')).toEqual({ status: 200, body: { head: null, commits: 0, role } });
    }
    expect(await get(f.viewer, 'snapshot')).toEqual({ status: 200, body: { head: null, files: [] } });
    expect(await get(f.viewer, 'log')).toEqual({ status: 200, body: [] });
  });

  it('a push round-trips through head, snapshot, changes and log, authored by the signed-in editor', async () => {
    const first = await push(f.editor, null, [commit('Share', [text('workspace.yaml', 'name: S\n')])]);
    expect(first.status).toBe(201);
    const second = await push(f.editor, first.body.head, [
      commit('Add project', [text('projects/p/project.yaml', 'a: 1\n')]),
      commit('Rename', [text('workspace.yaml', 'name: S2\n')]),
    ]);
    expect(second.status).toBe(201);
    expect(second.body.ids).toHaveLength(2);
    const base = first.body.head;
    const head = second.body.head;

    expect((await get<SyncHeadResponse>(f.viewer, `head?from=${base}`)).body).toEqual({
      head,
      commits: 3,
      behind: 2,
      role: 'viewer',
    });
    expect((await get<SyncSnapshotResponse>(f.viewer, 'snapshot')).body).toEqual({
      head,
      files: [text('projects/p/project.yaml', 'a: 1\n'), text('workspace.yaml', 'name: S2\n')],
    });
    expect((await get<SyncSnapshotResponse>(f.viewer, `snapshot?at=${base}`)).body).toEqual({
      head: base,
      files: [text('workspace.yaml', 'name: S\n')],
    });
    expect((await get<SyncChangesResponse>(f.viewer, `changes?from=${base}&to=${head}`)).body).toEqual({
      from: base,
      to: head,
      files: [text('projects/p/project.yaml', 'a: 1\n'), text('workspace.yaml', 'name: S2\n')],
    });
    expect((await get<SyncChangesResponse>(f.viewer, `changes?to=${base}`)).body).toEqual({
      from: null,
      to: base,
      files: [text('workspace.yaml', 'name: S\n')],
    });
    const author = 'editor <editor@example.com>';
    expect((await get<SyncLogEntry[]>(f.viewer, 'log?limit=2')).body).toEqual([
      { id: head, subject: 'Rename', author, at: AT },
      { id: second.body.ids[0], subject: 'Add project', author, at: AT },
    ]);
  });

  it('viewer, editor and admin read every route; a stranger gets 404 and no token 401; only editors and admins push', async () => {
    const first = await push(f.editor, null, [commit('One', [text('workspace.yaml', 'a\n')])]);
    for (const route of ['head', 'snapshot', `changes?to=${first.body.head}`, 'log']) {
      for (const user of [f.viewer, f.editor, f.admin]) expect((await get(user, route)).status).toBe(200);
      expect(await get(f.stranger, route)).toMatchObject({ status: 404, body: { code: 'teams-workspace-not-found' } });
      expect(await get(undefined, route)).toMatchObject({ status: 401, body: { code: 'identity-unauthenticated' } });
    }
    const next = [commit('Two', [text('workspace.yaml', 'b\n')])];
    expect(await push(f.viewer, first.body.head, next)).toMatchObject({
      status: 403,
      body: { code: 'teams-forbidden' },
    });
    expect(await push(f.stranger, first.body.head, next)).toMatchObject({
      status: 404,
      body: { code: 'teams-workspace-not-found' },
    });
    expect(await push(undefined, first.body.head, next)).toMatchObject({ status: 401 });
    const byAdmin = await push(f.admin, first.body.head, next);
    expect(byAdmin.status).toBe(201);
    expect((await get<SyncHeadResponse>(f.viewer, 'head')).body).toMatchObject({ head: byAdmin.body.head, commits: 2 });
  });

  it('an unknown commit is 404 sync-unknown-commit; a from that is not an ancestor is 400 sync-not-ancestor', async () => {
    const first = await push(f.editor, null, [commit('One', [text('workspace.yaml', 'a\n')])]);
    const second = await push(f.editor, first.body.head, [commit('Two', [text('workspace.yaml', 'b\n')])]);
    const unknown = 'f'.repeat(40);
    const routes = [
      `snapshot?at=${unknown}`,
      `changes?to=${unknown}`,
      `changes?from=${unknown}&to=${second.body.head}`,
    ];
    for (const route of routes) {
      expect(await get(f.viewer, route)).toMatchObject({ status: 404, body: { code: 'sync-unknown-commit' } });
    }
    expect(await get(f.viewer, `changes?from=${second.body.head}&to=${first.body.head}`)).toMatchObject({
      status: 400,
      body: { code: 'sync-not-ancestor' },
    });
    // §3.2: a base this server does not know counts the whole history as behind.
    expect((await get<SyncHeadResponse>(f.viewer, `head?from=${unknown}`)).body).toMatchObject({
      commits: 2,
      behind: 2,
    });
  });

  it('a commit id with a leading "-", or anything but a full lower-case hash, is 400 before git runs', async () => {
    const run = vi.spyOn(GitCli.prototype, 'run');
    const hash = 'a'.repeat(40);
    for (const bad of ['-abc', '--output=/tmp/x', 'HEAD', 'a'.repeat(39), 'A'.repeat(40)]) {
      const q = encodeURIComponent(bad);
      for (const route of [`head?from=${q}`, `snapshot?at=${q}`, `changes?to=${q}`, `changes?from=${q}&to=${hash}`]) {
        expect(await get(f.viewer, route)).toMatchObject({ status: 400, body: { code: 'invalid-request' } });
      }
      expect(await push(f.editor, bad, [commit('x', [text('workspace.yaml', 'x\n')])])).toMatchObject({
        status: 400,
        body: { code: 'invalid-request' },
      });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('the log limit comes from the query string as an integer from 1 to 200', async () => {
    const first = await push(f.editor, null, [commit('One', [text('workspace.yaml', 'a\n')])]);
    await push(f.editor, first.body.head, [commit('Two', [text('workspace.yaml', 'b\n')])]);
    expect((await get<SyncLogEntry[]>(f.viewer, 'log?limit=1')).body.map((entry) => entry.subject)).toEqual(['Two']);
    expect((await get<SyncLogEntry[]>(f.viewer, 'log')).body).toHaveLength(2);
    for (const limit of ['0', '201', '1.5', 'ten']) {
      expect(await get(f.viewer, `log?limit=${limit}`)).toMatchObject({
        status: 400,
        body: { code: 'invalid-request' },
      });
    }
  });
});
