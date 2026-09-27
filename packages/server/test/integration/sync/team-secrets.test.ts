import { afterEach, beforeEach, expect, it } from 'vitest';
import type {
  SyncChange,
  SyncLogEntry,
  SyncPushCommit,
  SyncPushResponse,
  SyncSnapshotResponse,
} from '@wirebench/engine';
import { describeDb } from '../../helpers/database.js';
import type { SignedInUser } from '../../helpers/identity.js';
import { syncFixture, type SyncFixture } from '../../helpers/sync.js';
import { call } from '../../helpers/teams.js';

const AT = '2026-09-26T12:00:00.000Z';
const KEY_ID = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ACCESS = 'team-secrets/access/01J8ZK6Q3V4W5X6Y7Z8A9B0C1D.yaml';
const text = (path: string, content: string): SyncChange => ({ path, encoding: 'utf8', content });
const commit = (subject: string, changes: SyncChange[]): SyncPushCommit => ({ subject, at: AT, changes });

describeDb('team secrets on the server (team-secrets §5.1)', () => {
  let f: SyncFixture;
  beforeEach(async () => {
    f = await syncFixture();
  });
  afterEach(() => f.h.close());

  const url = (route: string): string => `/workspaces/${f.workspaceId}/${route}`;
  const push = (as: SignedInUser, payload: object) =>
    call<SyncPushResponse & { code?: string }>(f.h, as, 'POST', url('sync/commits'), payload);
  const head = async () => (await call<{ head: string | null }>(f.h, f.viewer, 'GET', url('sync/head'))).body.head;
  const requestKey = (as: SignedInUser, body: object) =>
    call<{ head?: string; code?: string }>(f.h, as, 'POST', url('team-secrets/key-requests'), body);
  const snapshot = async () =>
    (await call<SyncSnapshotResponse>(f.h, f.viewer, 'GET', url('sync/snapshot'))).body.files.map((file) => file.path);

  it("refuses a non-admin's push that adds, changes or deletes an access entry, and writes nothing", async () => {
    const base = await push(f.admin, { parent: null, commits: [commit('Base', [text(ACCESS, 'genesis\n')])] });
    expect(base.status).toBe(201);
    const forged = [
      text(ACCESS, 'forged\n'),
      { path: ACCESS, encoding: 'utf8', content: null },
      text('TEAM-SECRETS/Access/X.yaml', 'x\n'),
    ];
    for (const change of forged) {
      expect(
        await push(f.editor, { parent: base.body.head, commits: [commit('Forge', [change as SyncChange])] }),
      ).toMatchObject({
        status: 403,
        body: {
          code: 'team-secrets-admin-only',
          message: 'Only a workspace admin can change who has access to team secrets.',
        },
      });
    }
    expect(await head()).toBe(base.body.head);
  });

  it("accepts an admin's access entry and an editor's key request and vault entry", async () => {
    const base = await push(f.admin, { parent: null, commits: [commit('Genesis', [text(ACCESS, 'genesis\n')])] });
    expect(base.status).toBe(201);
    const editor = await push(f.editor, {
      parent: base.body.head,
      commits: [
        commit('Update secret Key', [
          text(`team-secrets/keys/${KEY_ID}.yaml`, 'key\n'),
          text('team-secrets/values/BBCDEFGHIJKLMNOPQRSTUVWXYZ.yaml', 'value\n'),
        ]),
      ],
    });
    expect(editor.status).toBe(201);
  });

  it('lets a viewer add exactly one key file as a commit authored by them', async () => {
    const before = await head();
    const res = await requestKey(f.viewer, { keyId: KEY_ID, content: 'version: 1\n' });
    expect(res.status).toBe(201);
    expect(await head()).toBe(res.body.head);
    expect(await snapshot()).toEqual([`team-secrets/keys/${KEY_ID}.yaml`]);
    const log = await call<SyncLogEntry[]>(f.h, f.viewer, 'GET', url('sync/log'));
    expect(log.body[0]).toMatchObject({
      id: res.body.head,
      subject: 'Request team secrets access for viewer',
      author: 'viewer <viewer@example.com>',
    });
    expect(before).toBeNull();
  });

  it('refuses a key id that is not 26 base32 characters, a body over 4 KiB, a repeat and a stranger', async () => {
    for (const keyId of ['short', 'abcdefghijklmnopqrstuvwxyz', '../../../../workspace.yaml', `${KEY_ID}0`]) {
      expect(await requestKey(f.viewer, { keyId, content: 'x' })).toMatchObject({
        status: 400,
        body: { code: 'invalid-request' },
      });
    }
    expect(await requestKey(f.viewer, { keyId: KEY_ID, content: 'é'.repeat(3000) })).toMatchObject({ status: 400 });
    expect((await requestKey(f.editor, { keyId: KEY_ID, content: 'mine\n' })).status).toBe(201);
    expect(await requestKey(f.viewer, { keyId: KEY_ID, content: 'theirs\n' })).toMatchObject({
      status: 409,
      body: { code: 'team-secrets-key-exists' },
    });
    expect((await requestKey(f.stranger, { keyId: 'BBCDEFGHIJKLMNOPQRSTUVWXYZ', content: 'x' })).status).toBe(404);
    expect(await snapshot()).toEqual([`team-secrets/keys/${KEY_ID}.yaml`]);
  });
});
