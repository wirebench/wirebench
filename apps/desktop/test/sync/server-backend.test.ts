// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import type {
  SyncChangesResponse,
  SyncHeadResponse,
  SyncLogEntry,
  SyncPushRequest,
  SyncPushResponse,
  WorkspaceRole,
} from '@wirebench/engine';
import type { LiveEvent, LiveState, LiveWorkspaceMessage } from '../../src/main/live/live-client.js';
import type { LiveClients } from '../../src/main/live/live-clients.js';
import type { RemoteEvent } from '../../src/main/sync/backend.js';
import {
  mapServerError,
  ServerBackend,
  STOP_POLLING_CODES,
  type ServerBackendDeps,
} from '../../src/main/sync/server-backend.js';
import {
  applyChanges,
  diffTreeFiles,
  ServerState,
  writeTreeFiles,
  type TreeFile,
} from '../../src/main/sync/server-state.js';

const SERVER = 'https://wb.test';
const WS_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QC';
const TOKEN = `wbs_${'A'.repeat(43)}`;
const NOW = new Date('2026-09-25T12:00:00.000Z');
const A_EXAMPLE = 'name: QA\nurl: https://a.example\n';
const B_EXAMPLE = 'name: QA\nurl: https://b.example\n';
const text = (content: string): TreeFile => ({ encoding: 'utf8', content });
const problem = (code: string, status: number, message: string = code): WirebenchError =>
  new WirebenchError(code, message, { details: { status } });

interface StubCommit {
  readonly id: string;
  readonly files: ReadonlyMap<string, TreeFile>;
  readonly subject: string;
  readonly author: string;
  readonly at: string;
}

/**
 * An in-memory server with the §3.2 semantics the backend relies on: one linear history; a push
 * whose parent is not the head is `409 sync-push-rejected`; a viewer's push is `403 teams-forbidden`.
 */
class StubServer {
  readonly history: StubCommit[] = [];
  role: WorkspaceRole = 'editor';
  /** Like the server's `bodyLimitMb`: a push body longer than this is `413 request-too-large`. */
  limitBytes = Number.POSITIVE_INFINITY;

  head(): string | null {
    return this.history.at(-1)?.id ?? null;
  }

  filesAt(id: string | null): Map<string, TreeFile> {
    if (id === null) return new Map();
    const commit = this.history.find((candidate) => candidate.id === id);
    if (commit === undefined) throw problem('sync-unknown-commit', 404);
    return new Map(commit.files);
  }

  /** A teammate's commit: each path to new text, or `null` to delete it. */
  commit(changes: Readonly<Record<string, string | null>>, subject = 'Teammate change'): string {
    const files = this.filesAt(this.head());
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) files.delete(path);
      else files.set(path, text(content));
    }
    return this.append(files, subject, 'Bea <bea@example.com>');
  }

  private append(files: ReadonlyMap<string, TreeFile>, subject: string, author: string): string {
    const id = createHash('sha1')
      .update(String(this.history.length + 1))
      .digest('hex');
    this.history.push({ id, files, subject, author, at: NOW.toISOString() });
    return id;
  }

  readonly client = {
    syncHead: vi.fn((_url: string, _token: string, _id: string, from?: string | null): Promise<SyncHeadResponse> => {
      const index = from === undefined || from === null ? undefined : this.history.findIndex((c) => c.id === from);
      const behind =
        index === undefined ? undefined : index === -1 ? this.history.length : this.history.length - index - 1;
      return Promise.resolve({
        head: this.head(),
        commits: this.history.length,
        ...(behind !== undefined ? { behind } : {}),
        role: this.role,
      });
    }),
    syncChanges: vi.fn(
      (_url: string, _token: string, _id: string, from: string | null, to: string): Promise<SyncChangesResponse> => {
        const toIndex = this.history.findIndex((c) => c.id === to);
        const fromIndex = from === null ? -1 : this.history.findIndex((c) => c.id === from);
        if (toIndex === -1 || (from !== null && (fromIndex === -1 || fromIndex > toIndex)))
          return Promise.reject(problem('sync-not-ancestor', 400));
        return Promise.resolve({ from, to, files: diffTreeFiles(this.filesAt(from), this.filesAt(to)) });
      },
    ),
    pushCommits: vi.fn(
      (_url: string, _token: string, _id: string, body: SyncPushRequest): Promise<SyncPushResponse> => {
        if (Buffer.byteLength(JSON.stringify(body)) > this.limitBytes)
          return Promise.reject(problem('request-too-large', 413));
        if (this.role === 'viewer') return Promise.reject(problem('teams-forbidden', 403));
        if (body.parent !== this.head()) return Promise.reject(problem('sync-push-rejected', 409));
        const ids = body.commits.map((commit) =>
          this.append(applyChanges(this.filesAt(this.head()), commit.changes), commit.subject, 'Ada <ada@example.com>'),
        );
        return Promise.resolve({ head: ids.at(-1) ?? '', ids });
      },
    ),
    syncLog: vi.fn((_url: string, _token: string, _id: string, limit: number): Promise<SyncLogEntry[]> =>
      Promise.resolve(
        [...this.history]
          .reverse()
          .slice(0, limit)
          .map(({ id, subject, author, at }) => ({ id, subject, author, at })),
      ),
    ),
  };
}

/** A server whose history is one shared commit of three files. */
function seeded(): StubServer {
  const server = new StubServer();
  server.commit(
    { 'workspace.yaml': 'name: W\n', 'environments/qa.yaml': 'name: QA\n', 'environments/old.yaml': 'name: Old\n' },
    'Share workspace W',
  );
  return server;
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** A client that joined `server` at its head: the tree and the base are that snapshot. */
async function joined(
  server: StubServer,
  options: { readonly token?: string | null; readonly live?: ServerBackendDeps['live'] } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'wb-server-backend-'));
  roots.push(root);
  const tree = join(root, 'tree');
  const stateDir = join(root, 'server');
  const files = server.filesAt(server.head());
  await mkdir(tree, { recursive: true });
  await writeTreeFiles(tree, files);
  const state = await ServerState.initialize(stateDir, server.head(), files);
  const token = options.token === null ? undefined : (options.token ?? TOKEN);
  const accounts = {
    tokenFor: vi.fn<(url: string) => Promise<string | undefined>>(() => Promise.resolve(token)),
    markSignedOut: vi.fn<(url: string) => void>(() => undefined),
  };
  const make = (
    over: ServerState,
    defaultIdentity?: () => { readonly name: string; readonly email: string } | undefined,
  ): ServerBackend =>
    new ServerBackend({
      client: server.client,
      accounts,
      url: SERVER,
      workspaceId: WS_ID,
      tree,
      state: over,
      now: () => NOW,
      ...(defaultIdentity !== undefined ? { defaultIdentity } : {}),
      ...(options.live !== undefined ? { live: options.live } : {}),
    });
  const at = (path: string): string => join(tree, ...path.split('/'));
  return {
    server,
    state,
    stateDir,
    accounts,
    backend: make(state),
    /** A fresh backend over a fresh `ServerState` on the same folders: what a restart sees. */
    reopen: (defaultIdentity?: () => { readonly name: string; readonly email: string } | undefined) =>
      make(new ServerState(stateDir), defaultIdentity),
    async write(path: string, content: string): Promise<void> {
      await mkdir(dirname(at(path)), { recursive: true });
      await writeFile(at(path), content);
    },
    remove: (path: string): Promise<void> => rm(at(path), { force: true }),
    async read(path: string): Promise<string | undefined> {
      try {
        return await readFile(at(path), 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

/** B commits `B_EXAMPLE` to qa while the server gets `A_EXAMPLE` for qa and a new prod: one conflict. */
async function conflicted() {
  const server = seeded();
  const f = await joined(server);
  await f.write('environments/qa.yaml', B_EXAMPLE);
  await f.backend.commit('Update QA (B)');
  server.commit({ 'environments/qa.yaml': A_EXAMPLE, 'environments/prod.yaml': 'name: Prod\n' });
  await f.backend.fetch();
  const merged = await f.backend.merge();
  return { server, f, merged };
}

describe('mapServerError (§3.5)', () => {
  const rows: readonly (readonly [string, unknown, string])[] = [
    [
      'unreachable → offline',
      new WirebenchError('server-unreachable', 'Could not reach https://wb.test'),
      'sync-offline',
    ],
    ['internal → offline', problem('internal', 500), 'sync-offline'],
    ['any other 5xx problem (a restart) → offline', problem('server-shutting-down', 503), 'sync-offline'],
    ['a bad response of 500 or more → offline', problem('server-bad-response', 502), 'sync-offline'],
    [
      'a 2xx of the wrong shape stays itself',
      new WirebenchError('server-bad-response', 'The server answered with an unexpected shape'),
      'server-bad-response',
    ],
    ['a rejected push stays itself', problem('sync-push-rejected', 409), 'sync-push-rejected'],
    ['no token → signed out', new WirebenchError('account-signed-out', 'Sign in first.'), 'sync-signed-out'],
    ['401 → signed out', problem('identity-unauthenticated', 401), 'sync-signed-out'],
    ['a disabled account', problem('identity-user-disabled', 403), 'sync-account-disabled'],
    ['workspace not found → access removed', problem('teams-workspace-not-found', 404), 'sync-access-removed'],
    ['forbidden', problem('teams-forbidden', 403), 'sync-forbidden'],
    ['a body over the limit', problem('request-too-large', 413), 'sync-too-large'],
    ['a snapshot over the limit', problem('sync-too-large', 413), 'sync-too-large'],
    ['not an ancestor → history mismatch', problem('sync-not-ancestor', 400), 'sync-history-mismatch'],
    ['an unknown commit → history mismatch', problem('sync-unknown-commit', 404), 'sync-history-mismatch'],
    ['invalid-request stays itself', problem('invalid-request', 400), 'invalid-request'],
    ['a refused path stays itself', problem('sync-path-refused', 400), 'sync-path-refused'],
    ['anything that is not a WirebenchError', new Error('boom'), 'sync-failed'],
  ];
  for (const [name, error, code] of rows) {
    it(name, () => {
      const mapped = mapServerError(error);
      expect(mapped).toBeInstanceOf(WirebenchError);
      expect(mapped.code).toBe(code);
    });
  }

  it("keeps the server's message where it names the limit or the problem, and the cause everywhere", () => {
    const tooLarge = problem('sync-too-large', 413, 'The workspace is larger than this server allows (32 MB).');
    expect(mapServerError(tooLarge)).toMatchObject({
      code: 'sync-too-large',
      message: tooLarge.message,
      cause: tooLarge,
    });
    const invalid = problem('invalid-request', 400, 'body/commits must NOT have fewer than 1 items');
    expect(mapServerError(invalid)).toBe(invalid);
    expect(mapServerError(problem('teams-workspace-not-found', 404)).message).toBe(
      'You no longer have access; the files stay on this machine.',
    );
  });

  it('stops polling for signed out, a disabled account and removed access only', () => {
    expect([...STOP_POLLING_CODES].sort()).toEqual(['sync-access-removed', 'sync-account-disabled', 'sync-signed-out']);
  });
});

describe('ServerBackend over a stub server (§3.1)', () => {
  it('probe is local: server kind, sync available, remote and branch; uncommitted skips .git and non-tree files', async () => {
    const f = await joined(seeded());
    expect(await f.backend.probe()).toEqual({
      kind: 'server',
      gitAvailable: true,
      state: 'clean',
      ahead: 0,
      behind: 0,
      uncommitted: 0,
      remote: SERVER,
      branch: 'main',
    });
    await f.write('.git/config', '[core]\n');
    await f.write('notes.txt', 'not a tree item');
    await f.write('environments/staging.yaml', 'name: Staging\n');
    await f.write('workspace.yaml', 'name: W2\n');
    await f.remove('environments/qa.yaml');
    expect(await f.backend.probe()).toMatchObject({ state: 'clean', uncommitted: 3 });
    expect(await f.backend.changedPaths()).toEqual([
      { path: 'environments/qa.yaml', status: 'deleted' },
      { path: 'environments/staging.yaml', status: 'added' },
      { path: 'workspace.yaml', status: 'modified' },
    ]);
    expect(f.server.client.syncHead).not.toHaveBeenCalled();
  });

  it('fetch asks from the base and stores the known head, behind, role and lastSyncAt; a viewer shows in probe', async () => {
    const server = seeded();
    const f = await joined(server);
    const base = server.head();
    server.commit({ 'environments/qa.yaml': 'name: QA 2\n' });
    server.commit({ 'environments/prod.yaml': 'name: Prod\n' });
    server.role = 'viewer';
    expect(await f.backend.fetch()).toMatchObject({
      state: 'behind',
      behind: 2,
      role: 'viewer',
      lastSyncAt: NOW.toISOString(),
    });
    expect(server.client.syncHead).toHaveBeenCalledWith(SERVER, TOKEN, WS_ID, base);
    expect(await f.state.read()).toMatchObject({
      base: { head: base },
      knownHead: server.head(),
      behind: 2,
      role: 'viewer',
    });
    expect(await f.reopen().probe()).toMatchObject({ role: 'viewer', behind: 2 });
  });

  it('with no token fetch is sync-signed-out without a call; a rejected token also marks the account signed out', async () => {
    const signedOut = await joined(seeded(), { token: null });
    await expect(signedOut.backend.fetch()).rejects.toMatchObject({ code: 'sync-signed-out' });
    expect(signedOut.server.client.syncHead).not.toHaveBeenCalled();

    const f = await joined(seeded());
    f.server.client.syncHead.mockRejectedValueOnce(problem('identity-unauthenticated', 401));
    await expect(f.backend.fetch()).rejects.toMatchObject({ code: 'sync-signed-out' });
    expect(f.accounts.markSignedOut).toHaveBeenCalledWith(SERVER);
  });

  it('a server whose head went back to empty is a history mismatch', async () => {
    const server = seeded();
    const f = await joined(server);
    server.history.length = 0;
    await expect(f.backend.fetch()).rejects.toMatchObject({ code: 'sync-history-mismatch' });
  });

  it('merge is a no-op at the known head and refuses uncommitted changes before any network call', async () => {
    const server = seeded();
    const f = await joined(server);
    expect(await f.backend.merge()).toEqual({ conflicts: [], changedPaths: [] });
    server.commit({ 'environments/qa.yaml': 'name: QA 2\n' });
    await f.backend.fetch();
    await f.write('environments/local.yaml', 'name: Local\n');
    await expect(f.backend.merge()).rejects.toMatchObject({ code: 'sync-uncommitted' });
    expect(server.client.syncChanges).not.toHaveBeenCalled();
  });

  it('a clean merge with nothing pending writes their changes, advances the base and records no commit', async () => {
    const server = seeded();
    const f = await joined(server);
    const base = server.head();
    server.commit({
      'environments/qa.yaml': 'name: QA 2\n',
      'environments/prod.yaml': 'name: Prod\n',
      'environments/old.yaml': null,
    });
    await f.backend.fetch();
    expect(await f.backend.merge()).toEqual({
      conflicts: [],
      changedPaths: ['environments/old.yaml', 'environments/prod.yaml', 'environments/qa.yaml'],
    });
    expect(server.client.syncChanges).toHaveBeenCalledWith(SERVER, TOKEN, WS_ID, base, server.head());
    expect(await f.read('environments/qa.yaml')).toBe('name: QA 2\n');
    expect(await f.read('environments/old.yaml')).toBeUndefined();
    expect(await f.backend.probe()).toMatchObject({ state: 'clean', ahead: 0, behind: 0, uncommitted: 0 });
    expect((await f.state.read()).base.head).toBe(server.head());
    expect(await f.state.pending()).toEqual([]);
  });

  it('a clean merge over pending commits keeps the client ahead, and the push lands the merged tree', async () => {
    const server = seeded();
    const f = await joined(server);
    await f.write('environments/staging.yaml', 'name: Staging\n');
    expect(await f.backend.commit('Add staging')).toEqual({ committed: true });
    server.commit({ 'environments/qa.yaml': 'name: QA 2\n' });
    await f.backend.fetch();
    expect(await f.backend.probe()).toMatchObject({ state: 'diverged', ahead: 1, behind: 1 });
    expect(await f.backend.merge()).toEqual({ conflicts: [], changedPaths: ['environments/qa.yaml'] });
    expect(await f.backend.probe()).toMatchObject({ state: 'ahead', ahead: 1, behind: 0, uncommitted: 0 });
    await f.backend.push();
    const landed = server.filesAt(server.head());
    expect(landed.get('environments/staging.yaml')).toEqual(text('name: Staging\n'));
    expect(landed.get('environments/qa.yaml')).toEqual(text('name: QA 2\n'));
  });

  it('a Merge commit carries what replaying the pending commits over the new base would undo', async () => {
    const server = seeded();
    const f = await joined(server);
    await f.write('environments/qa.yaml', 'name: Mine\n');
    await f.backend.commit('Try QA');
    await f.write('environments/qa.yaml', 'name: QA\n');
    await f.backend.commit('Undo QA');
    server.commit({ 'environments/qa.yaml': 'name: QA 2\n' });
    await f.backend.fetch();
    expect(await f.backend.merge()).toEqual({ conflicts: [], changedPaths: ['environments/qa.yaml'] });
    const pending = await f.state.pending();
    expect(pending.map((commit) => commit.subject)).toEqual(['Try QA', 'Undo QA', 'Merge']);
    expect(pending[2]?.changes).toEqual([{ path: 'environments/qa.yaml', encoding: 'utf8', content: 'name: QA 2\n' }]);
    expect(await f.backend.probe()).toMatchObject({ uncommitted: 0, ahead: 3 });
    await f.backend.push();
    expect(server.filesAt(server.head()).get('environments/qa.yaml')).toEqual(text('name: QA 2\n'));
  });

  it.each(['mine', 'theirs'] as const)(
    'a conflict keeps mine in the tree, survives a restart, and resolves with %s through finishMerge and push',
    async (side) => {
      const { server, f, merged } = await conflicted();
      expect(merged).toEqual({
        changedPaths: [],
        conflicts: [{ path: 'environments/qa.yaml', entity: { kind: 'environment', name: 'qa' } }],
      });
      expect(await f.read('environments/qa.yaml')).toBe(B_EXAMPLE);
      expect(await f.read('environments/prod.yaml')).toBe('name: Prod\n');

      const reopened = f.reopen();
      expect(await reopened.probe()).toMatchObject({ state: 'conflict' });
      expect(await reopened.conflicts()).toEqual(merged.conflicts);
      await reopened.resolve('environments/qa.yaml', side);
      expect(await f.read('environments/qa.yaml')).toBe(side === 'mine' ? B_EXAMPLE : A_EXAMPLE);
      expect(await reopened.conflicts()).toEqual([]);

      const finished = await reopened.finishMerge();
      expect([...finished.changedPaths].sort()).toEqual(
        side === 'theirs' ? ['environments/prod.yaml', 'environments/qa.yaml'] : ['environments/prod.yaml'],
      );
      expect(await reopened.probe()).toMatchObject({ behind: 0, uncommitted: 0 });
      expect(await reopened.commit('nothing to see here')).toEqual({ committed: false });

      await reopened.push();
      expect(await reopened.probe()).toMatchObject({ state: 'clean', ahead: 0, behind: 0 });
      const landed = server.filesAt(server.head());
      expect(landed.get('environments/qa.yaml')).toEqual(text(side === 'mine' ? B_EXAMPLE : A_EXAMPLE));
      expect(landed.get('environments/prod.yaml')).toEqual(text('name: Prod\n'));
    },
  );

  it.each(['mine', 'theirs'] as const)(
    'modify/delete is a conflict when %s deleted the file, and resolving to that side keeps it deleted',
    async (deleted) => {
      const server = seeded();
      const f = await joined(server);
      if (deleted === 'mine') {
        await f.remove('environments/qa.yaml');
        await f.backend.commit('Delete QA (B)');
        server.commit({ 'environments/qa.yaml': A_EXAMPLE });
      } else {
        await f.write('environments/qa.yaml', B_EXAMPLE);
        await f.backend.commit('Modify QA (B)');
        server.commit({ 'environments/qa.yaml': null });
      }
      await f.backend.fetch();
      const merged = await f.backend.merge();
      expect(merged.conflicts.map((conflict) => conflict.path)).toEqual(['environments/qa.yaml']);
      // The modified side stays in the tree while the conflict is open, as git leaves it.
      expect(await f.read('environments/qa.yaml')).toBe(deleted === 'mine' ? A_EXAMPLE : B_EXAMPLE);

      await f.backend.resolve('environments/qa.yaml', deleted);
      expect(await f.read('environments/qa.yaml')).toBeUndefined();
      await f.backend.finishMerge();
      expect(await f.backend.conflicts()).toEqual([]);
      expect(await f.read('environments/qa.yaml')).toBeUndefined();
      await f.backend.push();
      expect(server.filesAt(server.head()).has('environments/qa.yaml')).toBe(false);
    },
  );

  it('abortMerge restores the pre-merge tree and leaves the client diverged', async () => {
    const { f } = await conflicted();
    await f.backend.abortMerge();
    expect(await f.backend.conflicts()).toEqual([]);
    expect(await f.read('environments/qa.yaml')).toBe(B_EXAMPLE);
    expect(await f.read('environments/prod.yaml')).toBeUndefined();
    expect(await f.backend.probe()).toMatchObject({ state: 'diverged', ahead: 1, behind: 1, uncommitted: 0 });
  });

  it('a fetch while a merge is open refreshes the role but the merge finishes against the head it was computed from', async () => {
    const { server, f } = await conflicted();
    const mergedAt = server.head();
    server.commit({ 'environments/later.yaml': 'name: Later\n' });
    server.role = 'admin';
    expect(await f.backend.fetch()).toMatchObject({ state: 'conflict', role: 'admin' });
    await f.backend.resolve('environments/qa.yaml', 'theirs');
    await f.backend.finishMerge();
    expect((await f.state.read()).base.head).toBe(mergedAt);
    expect(await f.read('environments/later.yaml')).toBeUndefined();
    expect(await f.backend.fetch()).toMatchObject({ behind: 1 });
  });

  it('reconnecting over an empty base: identical files merge, a different one conflicts, then the push lands (O2)', async () => {
    const server = new StubServer();
    const f = await joined(server);
    await f.write('workspace.yaml', 'name: W\n');
    await f.write('environments/qa.yaml', 'name: QA local\n');
    await f.write('environments/mine.yaml', 'name: Mine\n');
    await f.backend.commit('Share workspace W');
    server.commit(
      {
        'workspace.yaml': 'name: W\n',
        'environments/qa.yaml': 'name: QA\n',
        'environments/theirs.yaml': 'name: Theirs\n',
      },
      'Share workspace W',
    );

    await expect(f.backend.push()).rejects.toMatchObject({ code: 'sync-push-rejected' });
    expect(await f.backend.probe()).toMatchObject({ ahead: 1 });
    await f.backend.fetch();
    expect(server.client.syncHead).toHaveBeenLastCalledWith(SERVER, TOKEN, WS_ID, null);
    expect(await f.backend.probe()).toMatchObject({ state: 'diverged', behind: 1 });

    const merged = await f.backend.merge();
    expect(server.client.syncChanges).toHaveBeenLastCalledWith(SERVER, TOKEN, WS_ID, null, server.head());
    expect(merged.conflicts.map((conflict) => conflict.path)).toEqual(['environments/qa.yaml']);
    expect(await f.read('environments/theirs.yaml')).toBe('name: Theirs\n');
    await f.backend.resolve('environments/qa.yaml', 'mine');
    await f.backend.finishMerge();
    await f.backend.push();
    expect(Object.fromEntries(server.filesAt(server.head()))).toEqual({
      'workspace.yaml': text('name: W\n'),
      'environments/qa.yaml': text('name: QA local\n'),
      'environments/mine.yaml': text('name: Mine\n'),
      'environments/theirs.yaml': text('name: Theirs\n'),
    });
  });

  it('commit records the tree against the committed files, with one subject line and deletions as null', async () => {
    const f = await joined(seeded());
    expect(await f.backend.commit('nothing')).toEqual({ committed: false });
    await f.write('environments/qa.yaml', 'name: QA 2\n');
    await f.remove('environments/old.yaml');
    expect(await f.backend.commit('\nUpdate QA\n\nand remove old')).toEqual({ committed: true });
    const [commit, ...rest] = await f.state.pending();
    expect(rest).toEqual([]);
    expect(commit).toMatchObject({
      subject: 'Update QA',
      at: NOW.toISOString(),
      changes: [
        { path: 'environments/old.yaml', encoding: 'utf8', content: null },
        { path: 'environments/qa.yaml', encoding: 'utf8', content: 'name: QA 2\n' },
      ],
    });
    expect(await f.backend.probe()).toMatchObject({ state: 'ahead', ahead: 1, uncommitted: 0 });
  });

  it('a subject never carries a control character, which the server refuses (a CRLF line end, a tab)', async () => {
    const server = seeded();
    const f = await joined(server);
    await f.write('environments/qa.yaml', 'name: QA 2\n');
    expect(await f.backend.commit('Update\tQA\r\n\r\nbody')).toEqual({ committed: true });
    expect((await f.state.pending()).map((commit) => commit.subject)).toEqual(['Update QA']);
    await f.write('environments/qa.yaml', 'name: QA 3\n');
    await f.backend.commit('\u0000\r\n');
    expect((await f.state.pending()).map((commit) => commit.subject)).toEqual(['Update QA', 'Update workspace']);
  });

  it('push sends every pending commit on the base, then stands on the new head; with nothing pending it calls nothing', async () => {
    const server = seeded();
    const f = await joined(server);
    const base = server.head();
    await f.write('environments/a.yaml', 'a');
    await f.backend.commit('Add a');
    await f.write('environments/b.yaml', 'b');
    await f.backend.commit('Add b');
    expect(await f.backend.push()).toMatchObject({ state: 'clean', ahead: 0, behind: 0 });
    expect(server.client.pushCommits).toHaveBeenCalledWith(SERVER, TOKEN, WS_ID, {
      parent: base,
      commits: [
        {
          subject: 'Add a',
          at: NOW.toISOString(),
          changes: [{ path: 'environments/a.yaml', encoding: 'utf8', content: 'a' }],
        },
        {
          subject: 'Add b',
          at: NOW.toISOString(),
          changes: [{ path: 'environments/b.yaml', encoding: 'utf8', content: 'b' }],
        },
      ],
    });
    expect(await f.state.read()).toMatchObject({
      base: { head: server.head() },
      knownHead: server.head(),
      lastSyncAt: NOW.toISOString(),
    });
    expect(await f.state.pending()).toEqual([]);
    server.client.pushCommits.mockClear();
    await f.backend.push();
    expect(server.client.pushCommits).not.toHaveBeenCalled();
  });

  it('a rejected push keeps everything local; a forbidden one records the viewer role', async () => {
    const server = seeded();
    const f = await joined(server);
    await f.write('environments/a.yaml', 'a');
    await f.backend.commit('Add a');
    server.commit({ 'environments/b.yaml': 'b' });
    await expect(f.backend.push()).rejects.toMatchObject({ code: 'sync-push-rejected' });
    expect(await f.state.pending()).toHaveLength(1);
    expect(await f.read('environments/a.yaml')).toBe('a');

    const g = await joined(seeded());
    await g.backend.fetch();
    await g.write('environments/a.yaml', 'a');
    await g.backend.commit('Add a');
    g.server.role = 'viewer';
    await expect(g.backend.push()).rejects.toMatchObject({ code: 'sync-forbidden' });
    expect(await g.backend.probe()).toMatchObject({ role: 'viewer', ahead: 1 });
  });

  it("log lists pending commits newest first, then the server's history from the base, cached per base", async () => {
    const server = seeded();
    server.commit({ 'environments/qa.yaml': 'name: QA 2\n' }, 'Update QA');
    const f = await joined(server);
    server.commit({ 'environments/prod.yaml': 'name: Prod\n' }, 'Add prod (not merged yet)');
    await f.backend.fetch();
    await f.backend.setIdentity('Ada', 'ada@example.com');
    await f.write('environments/a.yaml', 'a');
    await f.backend.commit('Add a');
    await f.write('environments/b.yaml', 'b');
    await f.backend.commit('Add b');

    expect((await f.backend.log(10)).map((entry) => [entry.subject, entry.author])).toEqual([
      ['Add b', 'Ada <ada@example.com>'],
      ['Add a', 'Ada <ada@example.com>'],
      ['Update QA', 'Bea <bea@example.com>'],
      ['Share workspace W', 'Bea <bea@example.com>'],
    ]);
    // Eight more wanted, plus the one fetched-but-unmerged commit to skip.
    expect(server.client.syncLog).toHaveBeenCalledWith(SERVER, TOKEN, WS_ID, 9);
    expect(await f.backend.log(3)).toHaveLength(3);
    expect((await f.backend.log(1)).map((entry) => entry.subject)).toEqual(['Add b']);
    expect(server.client.syncLog).toHaveBeenCalledTimes(1);

    server.client.syncLog.mockRejectedValueOnce(
      new WirebenchError('server-unreachable', 'Could not reach https://wb.test'),
    );
    expect((await f.reopen().log(10)).map((entry) => entry.subject)).toEqual(['Add b', 'Add a']);
  });

  it('identity defaults to the signed-in account, and setIdentity persists over it', async () => {
    const f = await joined(seeded());
    const account = () => ({ name: 'Ada', email: 'ada@example.com' });
    expect(await f.backend.identity()).toBeUndefined();
    expect(await f.reopen(account).identity()).toEqual({ name: 'Ada', email: 'ada@example.com' });
    await f.backend.setIdentity('Bea', 'bea@example.com');
    expect(await f.reopen(account).identity()).toEqual({ name: 'Bea', email: 'bea@example.com' });
  });

  it('a push answered after another session committed keeps that commit pending, and out of the base (I1)', async () => {
    const server = seeded();
    const f = await joined(server);
    await f.write('environments/a.yaml', 'a');
    await f.backend.commit('Add a');
    let answer!: () => void;
    const gate = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const push = server.client.pushCommits.getMockImplementation()!;
    server.client.pushCommits.mockImplementationOnce(async (...args) => {
      const result = await push(...args);
      await gate;
      return result;
    });
    const pushing = f.backend.push();
    await vi.waitFor(() => expect(server.client.pushCommits).toHaveBeenCalledTimes(1));

    // The workspace was closed and reopened meanwhile: a second session commits a save.
    const second = f.reopen();
    await f.write('environments/qa.yaml', 'name: QA v2\n');
    expect(await second.commit('Edit QA')).toEqual({ committed: true });
    answer();
    await pushing;

    expect((await f.state.pending()).map((commit) => commit.subject)).toEqual(['Edit QA']);
    expect((await f.state.baseFiles()).get('environments/qa.yaml')).toEqual(text('name: QA\n'));
    expect(await second.probe()).toMatchObject({ state: 'ahead', ahead: 1, uncommitted: 0 });
    await second.push();
    expect(server.filesAt(server.head()).get('environments/qa.yaml')).toEqual(text('name: QA v2\n'));
    expect(await second.probe()).toMatchObject({ state: 'clean', ahead: 0 });
  });

  it('a save made while the changes download is not overwritten: the merge stops with sync-uncommitted (I2)', async () => {
    const server = seeded();
    const f = await joined(server);
    const base = server.head();
    server.commit({ 'environments/qa.yaml': 'name: QA theirs\n' });
    await f.backend.fetch();
    const changes = server.client.syncChanges.getMockImplementation()!;
    server.client.syncChanges.mockImplementationOnce(async (...args) => {
      const answer = await changes(...args);
      await f.write('environments/qa.yaml', 'name: QA mine\n'); // an autosave lands meanwhile
      return answer;
    });

    await expect(f.backend.merge()).rejects.toMatchObject({ code: 'sync-uncommitted' });

    expect(await f.read('environments/qa.yaml')).toBe('name: QA mine\n');
    expect(await f.state.readMerge()).toBeUndefined();
    expect((await f.state.read()).base.head).toBe(base);
    expect(await f.backend.probe()).toMatchObject({ state: 'behind', uncommitted: 1 });
  });

  it("pushes waiting commits in batches under the server's body limit, each on the last head, keeping every commit (I5)", async () => {
    const server = seeded();
    const f = await joined(server);
    for (let i = 0; i < 6; i += 1) {
      await f.write(`environments/e${i}.yaml`, `name: ${String(i).repeat(400)}\n`);
      await f.backend.commit(`Add e${i}`);
    }
    server.limitBytes = 1200; // two of these commits fit in one request, three do not

    expect(await f.backend.push()).toMatchObject({ state: 'clean', ahead: 0 });

    expect(server.history.map((commit) => commit.subject)).toEqual([
      'Share workspace W',
      ...[0, 1, 2, 3, 4, 5].map((i) => `Add e${i}`),
    ]);
    const landed = server.client.pushCommits.mock.calls
      .map(([, , , body]) => body)
      .filter((body) => Buffer.byteLength(JSON.stringify(body)) <= server.limitBytes);
    expect(landed.length).toBeGreaterThan(1);
    // Each request stands on the head the one before it made: the history stays linear.
    let sent = 0;
    for (const body of landed) {
      expect(body.parent).toBe(server.history[sent]!.id);
      sent += body.commits.length;
    }
    expect(sent).toBe(6);
    expect(await f.state.pending()).toEqual([]);
    expect((await f.state.read()).base.head).toBe(server.head());
  });

  it('a batch that lands before a later one fails stays pushed; one commit over the limit is sync-too-large and waits (I5)', async () => {
    const server = seeded();
    const f = await joined(server);
    await f.write('environments/small.yaml', 'name: Small\n');
    await f.backend.commit('Add small');
    await f.write('environments/big.yaml', `name: ${'b'.repeat(2000)}\n`);
    await f.backend.commit('Add big');
    server.limitBytes = 1000;

    await expect(f.backend.push()).rejects.toMatchObject({ code: 'sync-too-large' });

    expect(server.history.map((commit) => commit.subject)).toEqual(['Share workspace W', 'Add small']);
    expect((await f.state.pending()).map((commit) => commit.subject)).toEqual(['Add big']);
    expect((await f.state.read()).base.head).toBe(server.head());
    expect(await f.backend.probe()).toMatchObject({ state: 'ahead', ahead: 1, uncommitted: 0 });
  });

  it('a history mismatch and a damaged state guide to Stop sharing and sharing again, which keeps the files (I4)', async () => {
    const server = seeded();
    const f = await joined(server);
    server.history.length = 0;
    await expect(f.backend.fetch()).rejects.toThrow(/Stop sharing, then share it again/);
    await writeFile(join(f.stateDir, 'state.yaml'), 'version: [');
    expect((await f.reopen().probe()).error?.message).toMatch(/Stop sharing, then share it again/);
  });

  it('a damaged state is an error status from probe and sync-state-corrupt from everything else', async () => {
    const f = await joined(seeded());
    await writeFile(join(f.stateDir, 'state.yaml'), 'version: [');
    const backend = f.reopen();
    expect(await backend.probe()).toMatchObject({
      kind: 'server',
      gitAvailable: true,
      state: 'error',
      error: { code: 'sync-state-corrupt' },
    });
    await expect(backend.fetch()).rejects.toMatchObject({ code: 'sync-state-corrupt' });
  });
});

/**
 * A stand-in for `LiveClients` (live-updates §5.3). It records each subscription and lets a test
 * deliver events. The listener stays registered after its unsubscribe on purpose: dropping a late
 * delivery is the backend's job.
 */
function fakeLive() {
  const subscriptions: { readonly url: string; readonly workspaceId: string }[] = [];
  const listeners = new Set<(event: LiveEvent) => void>();
  const unsubscribe = vi.fn(() => undefined);
  const live: Pick<LiveClients, 'subscribe'> = {
    subscribe: (url, workspaceId, listener) => {
      subscriptions.push({ url, workspaceId });
      listeners.add(listener);
      return unsubscribe;
    },
  };
  const send = (event: LiveEvent): void => {
    for (const listener of listeners) listener(event);
  };
  return { live, subscriptions, unsubscribe, send };
}

const liveMessage = (message: LiveWorkspaceMessage): LiveEvent => ({ kind: 'message', message });
const socket = (state: LiveState): LiveEvent => ({ kind: 'state', state });
const head = (id: string): LiveEvent => liveMessage({ type: 'head', workspaceId: WS_ID, head: id });

function listen(backend: ServerBackend): { readonly events: RemoteEvent[]; readonly off: () => void } {
  const events: RemoteEvent[] = [];
  const off = backend.subscribeRemote((event) => {
    events.push(event);
  });
  return { events, off };
}

describe('ServerBackend.subscribeRemote (live-updates §3.4, §5.3, R1)', () => {
  const BEN = { id: '01J8ZC5Q0V7R3T9XK2M4N6P8QD', name: 'Ben' };
  const CY = { id: '01J8ZC5Q0V7R3T9XK2M4N6P8QE', name: 'Cy' };

  it('without live clients it is a no-op, as in the first slice', async () => {
    const f = await joined(seeded());
    const { events, off } = listen(f.backend);
    expect(() => off()).not.toThrow();
    expect(events).toEqual([]);
  });

  it("subscribes the share's own server and workspace, and delivers nothing once unsubscribed", async () => {
    const l = fakeLive();
    const f = await joined(seeded(), { live: l.live });
    const { events, off } = listen(f.backend);
    expect(l.subscriptions).toEqual([{ url: SERVER, workspaceId: WS_ID }]);

    l.send(liveMessage({ type: 'access', workspaceId: WS_ID }));
    off();
    expect(l.unsubscribe).toHaveBeenCalledTimes(1);
    l.send(liveMessage({ type: 'access', workspaceId: WS_ID }));
    l.send(socket('connecting'));

    expect(events).toEqual([{ kind: 'access' }]);
  });

  it('a head the last fetch or the base already names is silent; a new one is changed, with no network call', async () => {
    const server = seeded();
    const l = fakeLive();
    const f = await joined(server, { live: l.live });
    const base = server.head()!;
    const known = server.commit({ 'environments/qa.yaml': 'name: QA 2\n' });
    await f.backend.fetch();
    expect(await f.state.read()).toMatchObject({ base: { head: base }, knownHead: known });
    const { events } = listen(f.backend);

    l.send(head(known));
    l.send(head(base));
    l.send(head('c'.repeat(40)));

    // Head checks run in order: once the third has spoken, the first two have finished.
    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });
    expect(events).toEqual([{ kind: 'changed' }]);
    expect(server.client.syncHead).toHaveBeenCalledTimes(1);
  });

  it('a head over a damaged state asks for the fetch that reports the damage', async () => {
    const l = fakeLive();
    const f = await joined(seeded(), { live: l.live });
    await writeFile(join(f.stateDir, 'state.yaml'), 'version: [');
    const { events } = listen(f.reopen());

    l.send(head('d'.repeat(40)));

    await vi.waitFor(() => {
      expect(events).toEqual([{ kind: 'changed' }]);
    });
  });

  it('a listener that throws on its first changed still hears a later new head, and nothing escapes into the live callback', async () => {
    const l = fakeLive();
    const f = await joined(seeded(), { live: l.live });
    const events: RemoteEvent[] = [];
    let thrown = false;
    f.backend.subscribeRemote((event) => {
      events.push(event);
      if (event.kind === 'changed' && !thrown) {
        thrown = true;
        throw new Error('listener bug');
      }
      if (event.kind === 'access') throw new Error('listener bug');
    });

    l.send(head('e'.repeat(40)));
    await vi.waitFor(() => {
      expect(events).toEqual([{ kind: 'changed' }]);
    });
    expect(() => l.send(liveMessage({ type: 'access', workspaceId: WS_ID }))).not.toThrow();
    l.send(head('f'.repeat(40)));

    await vi.waitFor(() => {
      expect(events).toEqual([{ kind: 'changed' }, { kind: 'access' }, { kind: 'changed' }]);
    });
  });

  it('access and refused both ask for a fetch; presence passes the users through', async () => {
    const l = fakeLive();
    const f = await joined(seeded(), { live: l.live });
    const { events } = listen(f.backend);

    l.send(liveMessage({ type: 'access', workspaceId: WS_ID }));
    l.send(liveMessage({ type: 'refused', workspaceId: WS_ID, code: 'teams-workspace-not-found' }));
    l.send(liveMessage({ type: 'presence', workspaceId: WS_ID, users: [BEN, CY] }));
    l.send(liveMessage({ type: 'presence', workspaceId: WS_ID, users: [] }));

    expect(events).toEqual([
      { kind: 'access' },
      { kind: 'access' },
      { kind: 'presence', users: [BEN, CY] },
      { kind: 'presence', users: [] },
    ]);
  });

  it('socket states are live, and an ended session is ended', async () => {
    const l = fakeLive();
    const f = await joined(seeded(), { live: l.live });
    const { events } = listen(f.backend);

    l.send(socket('connecting'));
    l.send(socket('connected'));
    l.send(socket('off'));
    l.send(socket('ended'));

    expect(events).toEqual([
      { kind: 'live', state: 'connecting' },
      { kind: 'live', state: 'connected' },
      { kind: 'live', state: 'off' },
      { kind: 'ended' },
    ]);
  });

  it('an ended session straight from connected reads off before ended, so the dot never stays on Live', async () => {
    const l = fakeLive();
    const f = await joined(seeded(), { live: l.live });
    const { events } = listen(f.backend);

    l.send(socket('connected'));
    l.send(socket('ended'));

    expect(events).toEqual([{ kind: 'live', state: 'connected' }, { kind: 'live', state: 'off' }, { kind: 'ended' }]);
  });

  it('refused for too many subscriptions reads off until the socket reconnects, so the workspace polls (§3.5)', async () => {
    const l = fakeLive();
    const f = await joined(seeded(), { live: l.live });
    const { events } = listen(f.backend);

    l.send(socket('connected'));
    l.send(liveMessage({ type: 'refused', workspaceId: WS_ID, code: 'live-too-many-subscriptions' }));
    l.send(socket('connected'));
    l.send(socket('connecting'));
    l.send(socket('connected'));

    expect(events).toEqual([
      { kind: 'live', state: 'connected' },
      { kind: 'access' },
      { kind: 'live', state: 'off' },
      { kind: 'live', state: 'off' },
      { kind: 'live', state: 'connecting' },
      { kind: 'live', state: 'connected' },
    ]);
  });
});

describe('the import graph (O4)', () => {
  it('reaches no electron import from server-backend.ts', async () => {
    const seen = new Set<string>();
    const visit = async (file: string): Promise<void> => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = await readFile(file, 'utf8');
      expect(source, file).not.toMatch(/from 'electron'|import\('electron'\)|require\('electron'\)/);
      for (const match of source.matchAll(/from '(\.{1,2}\/[^']+)\.js'/g)) {
        await visit(resolve(dirname(file), `${match[1] ?? ''}.ts`));
      }
    };
    await visit(fileURLToPath(new URL('../../src/main/sync/server-backend.ts', import.meta.url)));
    const names = [...seen].map((file) => file.split(/[\\/]/).at(-1) ?? '');
    for (const name of [
      'server-state.ts',
      'server-token.ts',
      'server-client.ts',
      'account-service.ts',
      'live-clients.ts',
      'live-client.ts',
    ])
      expect(names).toContain(name);
  });
});
