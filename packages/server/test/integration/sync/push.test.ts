import { afterEach, beforeEach, expect, it } from 'vitest';
import type { SyncChange, SyncHeadResponse, SyncLogEntry, SyncPushCommit, SyncPushResponse } from '@wirebench/engine';
import { describeDb } from '../../helpers/database.js';
import type { SignedInUser } from '../../helpers/identity.js';
import { syncFixture, type SyncFixture } from '../../helpers/sync.js';
import { call } from '../../helpers/teams.js';

const AT = '2026-09-24T12:00:00.000Z';
const text = (path: string, content: string): SyncChange => ({ path, encoding: 'utf8', content });
const commit = (subject: string, changes: SyncChange[]): SyncPushCommit => ({ subject, at: AT, changes });

describeDb('POST …/sync/commits (§3.2)', () => {
  let f: SyncFixture;
  beforeEach(async () => {
    f = await syncFixture();
  });
  afterEach(() => f.h.close());

  const url = (route: string): string => `/workspaces/${f.workspaceId}/sync/${route}`;
  const push = (as: SignedInUser, payload: object) =>
    call<SyncPushResponse & { code?: string }>(f.h, as, 'POST', url('commits'), payload);
  const head = async () => (await call<SyncHeadResponse>(f.h, f.viewer, 'GET', url('head'))).body.head;

  it('a parent that is not the head is 409 sync-push-rejected, with a code and a message and no head (R3)', async () => {
    const first = await push(f.editor, { parent: null, commits: [commit('One', [text('workspace.yaml', 'a\n')])] });
    expect(first.status).toBe(201);
    for (const parent of [null, 'b'.repeat(40)]) {
      expect(await push(f.admin, { parent, commits: [commit('Stale', [text('workspace.yaml', 'z\n')])] })).toEqual({
        status: 409,
        body: { code: 'sync-push-rejected', message: expect.any(String) as string },
      });
    }
    expect(await head()).toBe(first.body.head);
  });

  it('commits are authored by the signed-in user; an author in the body changes nothing (§6)', async () => {
    const res = await push(f.editor, {
      parent: null,
      commits: [{ ...commit('Mine', [text('workspace.yaml', 'a\n')]), author: 'Mallory <mallory@example.com>' }],
    });
    expect(res.status).toBe(201);
    const log = await call<SyncLogEntry[]>(f.h, f.viewer, 'GET', url('log'));
    expect(log.body).toEqual([{ id: res.body.head, subject: 'Mine', author: 'editor <editor@example.com>', at: AT }]);
  });

  it('refuses .git/…, the machine-local files and ../x with 400 sync-path-refused, and writes nothing', async () => {
    const refused = ['.git/config', 'projects/.git/HEAD', 'share.yaml', 'local.yaml', 'unsaved/x.yaml', '../x'];
    for (const path of [...refused, 'projects/../../x']) {
      expect(await push(f.editor, { parent: null, commits: [commit('Bad', [text(path, 'x')])] })).toMatchObject({
        status: 400,
        body: { code: 'sync-path-refused' },
      });
    }
    expect(await head()).toBeNull();
  });

  it('a subject with a control character (NUL, a line break, DEL) is 400 invalid-request, and writes nothing', async () => {
    for (const subject of ['nul \u0000 inside', 'two\nlines', 'carriage\rreturn', 'tab\there', 'del \u007f']) {
      const commits = [
        commit('Fine', [text('workspace.yaml', 'a\n')]),
        commit(subject, [text('workspace.yaml', 'b\n')]),
      ];
      expect(await push(f.editor, { parent: null, commits })).toMatchObject({
        status: 400,
        body: { code: 'invalid-request' },
      });
    }
    expect(await head()).toBeNull();
  });

  it('content that does not decode, and malformed bodies, are 400 invalid-request', async () => {
    const bodies: object[] = [
      {
        parent: null,
        commits: [commit('B64', [{ path: 'workspace.yaml', encoding: 'base64', content: 'not base64!' }])],
      },
      { parent: null, commits: [commit('Utf8', [text('workspace.yaml', 'lone \ud800 surrogate')])] },
      { parent: null, commits: [] },
      { commits: [commit('No parent', [text('workspace.yaml', 'a\n')])] },
      {
        parent: null,
        // An encoding the schema does not know, so it is not a SyncChange.
        commits: [{ subject: 'Hex', at: AT, changes: [{ path: 'workspace.yaml', encoding: 'hex', content: '00' }] }],
      },
      { parent: null, commits: [commit('Long', [text(`projects/${'p'.repeat(520)}.yaml`, 'a\n')])] },
      { parent: null, commits: [{ subject: '', at: AT, changes: [] }] },
    ];
    for (const body of bodies) {
      expect(await push(f.editor, body)).toMatchObject({ status: 400, body: { code: 'invalid-request' } });
    }
    expect(await head()).toBeNull();
  });
});

describeDb('size limits (R5)', () => {
  let f: SyncFixture;
  beforeEach(async () => {
    f = await syncFixture({ env: { WIREBENCH_SERVER_BODY_LIMIT_MB: '1' } });
  });
  afterEach(() => f.h.close());

  const url = (route: string): string => `/workspaces/${f.workspaceId}/sync/${route}`;

  it('a push body over bodyLimitMb is 413 request-too-large', async () => {
    const big = 'a'.repeat(1536 * 1024);
    const res = await call(f.h, f.editor, 'POST', url('commits'), {
      parent: null,
      commits: [commit('Big', [text('projects/p/big.txt', big)])],
    });
    expect(res).toEqual({
      status: 413,
      body: { code: 'request-too-large', message: 'Request bodies are limited to 1 MiB.' },
    });
  });

  it('a snapshot or changes answer over bodyLimitMb is 413 sync-too-large naming the limit; each push alone fits', async () => {
    const big = 'a'.repeat(600 * 1024);
    const first = await call<SyncPushResponse>(f.h, f.editor, 'POST', url('commits'), {
      parent: null,
      commits: [commit('A', [text('projects/p/a.txt', big)])],
    });
    const second = await call<SyncPushResponse>(f.h, f.editor, 'POST', url('commits'), {
      parent: first.body.head,
      commits: [commit('B', [text('projects/p/b.txt', big)])],
    });
    expect([first.status, second.status]).toEqual([201, 201]);
    for (const route of ['snapshot', `changes?to=${second.body.head}`]) {
      const res = await call<{ code: string; message: string }>(f.h, f.viewer, 'GET', url(route));
      expect(res.status).toBe(413);
      expect(res.body.code).toBe('sync-too-large');
      expect(res.body.message).toContain('1 MiB');
    }
    const oneFile = await call(f.h, f.viewer, 'GET', url(`changes?from=${first.body.head}&to=${second.body.head}`));
    expect(oneFile.status).toBe(200);
    expect((await call(f.h, f.viewer, 'GET', url('log'))).status).toBe(200);
  });
});
