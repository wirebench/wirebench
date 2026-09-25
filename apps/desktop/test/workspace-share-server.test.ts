// @vitest-environment node
/**
 * Share to, join from and stop sharing with Wirebench Server (server-sync §3.4), over a temp
 * `userData` and an in-memory stub server:
 * - the `workspace-share.ts` functions run directly, over a hand-built `ShareDeps`;
 * - `WorkspaceService` runs once end to end, so the catch-up push and the reconnect merge (O2) go
 *   through the real `ServerBackend` and `SyncService`.
 * Needs no git: a server share never runs it.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProject,
  createWorkspace,
  generateId,
  loadShare,
  loadWorkspace,
  saveProject,
  saveWorkspace,
  SERVER_API_VERSION,
  SERVER_NAME,
  TEAMS_ID_PATTERN,
  WirebenchError,
  workspaceDir,
} from '@wirebench/engine';
import type {
  MetaResponse,
  ServerAccount,
  SyncChangesResponse,
  SyncHeadResponse,
  SyncLogEntry,
  SyncPushRequest,
  SyncPushResponse,
  SyncSnapshotResponse,
  TeamWorkspace,
  TeamWorkspaceCreateRequest,
  WorkspaceProjectRef,
  WorkspaceRole,
} from '@wirebench/engine';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService } from '../src/main/history-service.js';
import { normalizeServerUrl } from '../src/main/server-client.js';
import type { ServerClient } from '../src/main/server-client.js';
import { applyChanges, readTreeFiles, SERVER_STATE_DIR, ServerState } from '../src/main/sync/server-state.js';
import type { TreeFile } from '../src/main/sync/server-state.js';
import { resolveWorkspaceTree } from '../src/main/workspace-files.js';
import { WorkspaceService } from '../src/main/workspace-service.js';
import type { WorkspaceHooks } from '../src/main/workspace-service.js';
import {
  joinFromServer,
  nodeFileOps,
  openableTeamWorkspaces,
  serverShareTargets,
  shareToServer,
  stopSharing,
} from '../src/main/workspace-share.js';
import type {
  OpenWorkspaceInfo,
  ServerShareRequest,
  ServerShareTarget,
  ShareDeps,
} from '../src/main/workspace-share.js';
import { WorkspaceState } from '../src/main/workspace-state.js';
import type { SyncConflictWire, WorkspaceWire } from '../src/shared/wire-types.js';

const WAIT = { timeout: 15_000, interval: 50 };
const URL_A = 'https://wirebench.example.test';
const URL_B = 'https://other.example.test';
const TOKEN = 'token-a';
const TEAM_ID = generateId();
const TEAM_NAME = 'Payments QA';
const ACCOUNT: ServerAccount = {
  url: URL_A,
  userId: generateId(),
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
  deviceName: 'laptop',
  tokenRef: `sec_${'0'.repeat(26)}`,
  addedAt: '2026-09-25T00:00:00.000Z',
};
const ONE_FILE = new Map<string, TreeFile>([['workspace.yaml', { encoding: 'utf8', content: 'formatVersion: 3\n' }]]);

let base: string;
let serial = 0;
const services: WorkspaceService[] = [];

beforeEach(async () => {
  base = await realpath(mkdtempSync(join(tmpdir(), 'wirebench-share-server-')));
});

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.close();
  }
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** What `ServerClient` throws for a problem answer: the server's code, and the status in details. */
function problem(code: string, message: string, status: number): WirebenchError {
  return new WirebenchError(code, message, { details: { status } });
}

/** Runs `compute` as an async answer: a throw inside becomes the rejection, as an HTTP error would. */
function answer<T>(compute: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(compute());
  });
}

interface StubWorkspace {
  readonly row: TeamWorkspace;
  /** Another team's workspace: listed nowhere, and its head answers 404, but its id is taken. */
  readonly hidden: boolean;
  head: string | null;
  commits: number;
  files: Map<string, TreeFile>;
}

/** An in-memory Wirebench Server answering the calls the share flows and `ServerBackend` make. */
class StubServer {
  capabilities: string[] = ['sync'];
  createFailure: WirebenchError | undefined;
  readonly calls: string[] = [];
  readonly createAttempts: { readonly teamId: string; readonly body: TeamWorkspaceCreateRequest }[] = [];
  readonly pushes: { readonly parent: string | null; readonly accepted: boolean }[] = [];
  private readonly workspaces = new Map<string, StubWorkspace>();
  private minted = 0;

  add(input: {
    readonly id?: string;
    readonly name: string;
    readonly role?: WorkspaceRole;
    readonly teamId?: string;
    readonly files?: ReadonlyMap<string, TreeFile>;
    readonly hidden?: boolean;
  }): TeamWorkspace {
    const row: TeamWorkspace = {
      id: input.id ?? generateId(),
      name: input.name,
      teamId: input.teamId ?? TEAM_ID,
      teamName: TEAM_NAME,
      defaultRole: 'viewer',
      myRole: input.role ?? 'editor',
      source: 'default',
      createdAt: '2026-09-25T00:00:00.000Z',
    };
    const files = new Map<string, TreeFile>(input.files ?? []);
    this.workspaces.set(row.id, {
      row,
      hidden: input.hidden ?? false,
      head: files.size > 0 ? this.mint() : null,
      commits: files.size > 0 ? 1 : 0,
      files,
    });
    return row;
  }

  has(id: string): boolean {
    return this.workspaces.has(id);
  }

  headOf(id: string): string | null {
    return this.workspaces.get(id)?.head ?? null;
  }

  filesOf(id: string): ReadonlyMap<string, TreeFile> {
    return this.workspaces.get(id)?.files ?? new Map<string, TreeFile>();
  }

  meta(url: string): Promise<MetaResponse> {
    this.calls.push('meta');
    return answer(() => ({
      name: SERVER_NAME,
      version: '0.0.0-test',
      apiVersion: SERVER_API_VERSION,
      publicUrl: url,
      auth: { local: true, oidc: false },
      capabilities: [...this.capabilities],
    }));
  }

  /** Takes (url, token) like `ServerClient`; neither matters to the stub, so neither is declared. */
  listWorkspaces(): Promise<TeamWorkspace[]> {
    this.calls.push('listWorkspaces');
    return answer(() => [...this.workspaces.values()].filter((found) => !found.hidden).map((found) => found.row));
  }

  createWorkspace(
    _url: string,
    _token: string,
    teamId: string,
    body: TeamWorkspaceCreateRequest,
  ): Promise<TeamWorkspace> {
    this.calls.push('createWorkspace');
    this.createAttempts.push({ teamId, body });
    return answer(() => {
      if (this.createFailure !== undefined) {
        throw this.createFailure;
      }
      if (body.id !== undefined && this.workspaces.has(body.id)) {
        throw problem('teams-workspace-exists', 'A workspace with this id already exists.', 409);
      }
      return this.add({ ...(body.id !== undefined ? { id: body.id } : {}), name: body.name, teamId, role: 'admin' });
    });
  }

  syncHead(_url: string, _token: string, workspaceId: string, from?: string | null): Promise<SyncHeadResponse> {
    this.calls.push('syncHead');
    return answer(() => {
      const found = this.visible(workspaceId);
      const behind = from === undefined || from === null ? {} : { behind: from === found.head ? 0 : found.commits };
      return { head: found.head, commits: found.commits, ...behind, role: found.row.myRole };
    });
  }

  syncSnapshot(_url: string, _token: string, workspaceId: string): Promise<SyncSnapshotResponse> {
    this.calls.push('syncSnapshot');
    return answer(() => {
      const found = this.visible(workspaceId);
      return { head: found.head, files: [...found.files].map(([path, file]) => ({ path, ...file })) };
    });
  }

  syncChanges(
    _url: string,
    _token: string,
    workspaceId: string,
    from: string | null,
    to: string,
  ): Promise<SyncChangesResponse> {
    this.calls.push('syncChanges');
    return answer(() => {
      const found = this.visible(workspaceId);
      if (to !== found.head) {
        throw problem('sync-unknown-commit', 'Unknown commit.', 404);
      }
      if (from === to) {
        return { from, to, files: [] };
      }
      if (from !== null) {
        throw problem('sync-not-ancestor', 'Not an ancestor of the head.', 400);
      }
      return { from: null, to, files: [...found.files].map(([path, file]) => ({ path, ...file })) };
    });
  }

  pushCommits(_url: string, _token: string, workspaceId: string, body: SyncPushRequest): Promise<SyncPushResponse> {
    this.calls.push('pushCommits');
    return answer(() => {
      const found = this.visible(workspaceId);
      if (body.parent !== found.head) {
        this.pushes.push({ parent: body.parent, accepted: false });
        throw problem('sync-push-rejected', 'Someone else pushed first.', 409);
      }
      const ids: string[] = [];
      for (const commit of body.commits) {
        found.files = applyChanges(found.files, commit.changes);
        ids.push(this.mint());
      }
      const head = ids[ids.length - 1];
      if (head === undefined) {
        throw problem('invalid-request', 'A push carries at least one commit.', 400);
      }
      found.head = head;
      found.commits += ids.length;
      this.pushes.push({ parent: body.parent, accepted: true });
      return { head, ids };
    });
  }

  syncLog(_url: string, _token: string, workspaceId: string): Promise<SyncLogEntry[]> {
    this.calls.push('syncLog');
    return answer((): SyncLogEntry[] => {
      this.visible(workspaceId);
      return [];
    });
  }

  private visible(workspaceId: string): StubWorkspace {
    const found = this.workspaces.get(workspaceId);
    if (found === undefined || found.hidden) {
      throw problem('teams-workspace-not-found', 'Workspace not found.', 404);
    }
    return found;
  }

  private mint(): string {
    this.minted += 1;
    return createHash('sha1')
      .update(`commit-${String(this.minted)}`)
      .digest('hex');
  }
}

/** The signed-in account for `URL_A` (or none), as `AccountService` answers for it. */
function accountsFor(signedIn: boolean): {
  tokenFor: (url: string) => Promise<string | undefined>;
  markSignedOut: (url: string) => void;
  list: () => readonly ServerAccount[];
} {
  return {
    tokenFor: (url) => Promise.resolve(signedIn && normalizeServerUrl(url) === URL_A ? TOKEN : undefined),
    markSignedOut: vi.fn<(url: string) => void>(),
    list: () => [ACCOUNT],
  };
}

/** The workspace wire `open` would answer: enough for these tests to see which workspace opened. */
async function wireOf(root: string, id: string): Promise<WorkspaceWire> {
  const dir = workspaceDir(root, id);
  const { tree } = await resolveWorkspaceTree(dir);
  const { workspace } = await loadWorkspace(tree);
  return { id: workspace.id, name: workspace.name, dir, properties: {}, disabled: [], environments: [], projects: [] };
}

interface Harness {
  readonly root: string;
  readonly server: StubServer;
  readonly state: WorkspaceState;
  readonly deps: ShareDeps;
  readonly opened: { readonly id: string; readonly initialCommitMessage?: string }[];
  closes(): number;
}

/** A fresh `userData` and the `ShareDeps` `WorkspaceService` would hand the share functions. */
async function harness(options: { readonly signedIn?: boolean } = {}): Promise<Harness> {
  serial += 1;
  const root = join(base, `user-${String(serial)}`);
  await mkdir(root, { recursive: true });
  const server = new StubServer();
  const state = new WorkspaceState(root);
  const opened: { readonly id: string; readonly initialCommitMessage?: string }[] = [];
  let closes = 0;
  const deps: ShareDeps = {
    userDataDir: root,
    files: nodeFileOps,
    fsOption: undefined,
    git: () => Promise.resolve(undefined),
    ready: Promise.resolve(),
    close: () => {
      closes += 1;
      return Promise.resolve(null);
    },
    open: async (id, openOptions) => {
      opened.push({
        id,
        ...(openOptions?.initialCommitMessage !== undefined
          ? { initialCommitMessage: openOptions.initialCommitMessage }
          : {}),
      });
      return await wireOf(root, id);
    },
    server: { client: server, accounts: accountsFor(options.signedIn ?? true), state },
  };
  return { root, server, state, deps, opened, closes: () => closes };
}

/** A local workspace named `Team` with one internal project `Calc` and an unsaved record. */
async function seedLocal(
  root: string,
  options: { readonly id?: string; readonly linked?: boolean } = {},
): Promise<{ readonly id: string; readonly dir: string }> {
  const project = createProject('Calc');
  const refs: WorkspaceProjectRef[] = [{ id: project.id, slug: 'Calc', source: 'internal' }];
  if (options.linked === true) {
    refs.push({ id: generateId(), slug: 'Elsewhere', source: 'linked', path: join(base, 'elsewhere-project') });
  }
  const workspace = {
    ...createWorkspace('Team', options.id !== undefined ? { id: options.id } : {}),
    projects: refs,
  };
  const dir = workspaceDir(root, workspace.id);
  await mkdir(join(dir, 'projects', 'Calc'), { recursive: true });
  await saveProject(project, join(dir, 'projects', 'Calc'));
  await saveWorkspace(workspace, dir);
  await mkdir(join(dir, 'unsaved'), { recursive: true });
  await writeFile(join(dir, 'unsaved', 'marker.txt'), 'keep me', 'utf8');
  return { id: workspace.id, dir };
}

/** A workspace as a server holds it: seeded in another user's data folder, read as tree files. */
async function serverCopy(
  options: { readonly id?: string } = {},
): Promise<{ readonly id: string; readonly files: Map<string, TreeFile> }> {
  serial += 1;
  const { id, dir } = await seedLocal(join(base, `elsewhere-${String(serial)}`), options);
  return { id, files: await readTreeFiles(dir) };
}

/** The open local workspace `id`, as `WorkspaceService` hands it to the share functions. */
async function localInfo(root: string, id: string): Promise<OpenWorkspaceInfo> {
  const dir = workspaceDir(root, id);
  const { workspace } = await loadWorkspace(dir);
  return { workspace, dir, tree: dir, share: undefined };
}

function shareRequest(target: ServerShareTarget, teamName = TEAM_NAME): ServerShareRequest {
  return { url: URL_A, teamId: TEAM_ID, teamName, target };
}

/** `dir` is a local workspace again, exactly as {@link seedLocal} left it. */
async function expectLocal(dir: string): Promise<void> {
  expect(existsSync(join(dir, 'workspace.yaml'))).toBe(true);
  expect(existsSync(join(dir, 'projects', 'Calc', 'wirebench.yaml'))).toBe(true);
  expect(existsSync(join(dir, 'tree'))).toBe(false);
  expect(existsSync(join(dir, 'share.yaml'))).toBe(false);
  expect(existsSync(join(dir, SERVER_STATE_DIR))).toBe(false);
  expect(await readFile(join(dir, 'unsaved', 'marker.txt'), 'utf8')).toBe('keep me');
}

describe('shareToServer — a new team workspace (§3.4)', () => {
  it('moves the tree into <id>/tree, writes an empty base and share.yaml, creates the server workspace under the local id, and opens with the share commit', async () => {
    const h = await harness();
    const { id, dir } = await seedLocal(h.root);

    const wire = await shareToServer(h.deps, await localInfo(h.root, id), {
      url: `${URL_A}/ignored/path`,
      teamId: TEAM_ID,
      teamName: TEAM_NAME,
      target: { kind: 'new', name: '  Team  ', defaultRole: 'viewer' },
    });

    expect(wire.id).toBe(id);
    expect(h.server.createAttempts).toEqual([{ teamId: TEAM_ID, body: { id, name: 'Team', defaultRole: 'viewer' } }]);
    expect(existsSync(join(dir, 'tree', 'workspace.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'tree', 'projects', 'Calc', 'wirebench.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'tree', '.gitattributes'))).toBe(false);
    expect(existsSync(join(dir, 'workspace.yaml'))).toBe(false);
    expect(await readFile(join(dir, 'unsaved', 'marker.txt'), 'utf8')).toBe('keep me');
    expect(await loadShare(dir)).toEqual({
      version: 1,
      kind: 'server',
      server: {
        url: URL_A,
        workspaceId: id,
        teamName: TEAM_NAME,
        autoFetchSeconds: 60,
        commitOnSave: true,
        pushOnSave: true,
      },
    });
    const state = new ServerState(join(dir, SERVER_STATE_DIR));
    expect(await state.read()).toMatchObject({
      version: 1,
      base: { head: null },
      identity: { name: 'Ada Lovelace', email: 'ada@example.com' },
    });
    expect((await state.baseFiles()).size).toBe(0);
    expect(await state.pending()).toEqual([]);
    expect(h.closes()).toBe(1);
    expect(h.opened).toEqual([{ id, initialCommitMessage: 'Share workspace Team' }]);
  });

  it('adopts a fresh ULID when the manifest id is not one (R10), moving the folder and the workspace state with it', async () => {
    const h = await harness();
    const { dir } = await seedLocal(h.root, { id: 'legacy-workspace-1' });
    await h.state.remember('legacy-workspace-1', '2026-09-20T10:00:00.000Z');

    const wire = await shareToServer(
      h.deps,
      await localInfo(h.root, 'legacy-workspace-1'),
      shareRequest({ kind: 'new', name: 'Team' }),
    );

    expect(wire.id).toMatch(TEAMS_ID_PATTERN);
    const adopted = workspaceDir(h.root, wire.id);
    expect(existsSync(dir)).toBe(false);
    expect((await loadWorkspace(join(adopted, 'tree'))).workspace).toMatchObject({ id: wire.id, name: 'Team' });
    expect((await loadShare(adopted))?.server?.workspaceId).toBe(wire.id);
    expect(h.server.createAttempts[0]?.body.id).toBe(wire.id);
    expect(await h.state.read()).toEqual({
      version: 1,
      lastOpenedWorkspaceId: wire.id,
      lastOpenedAt: { [wire.id]: '2026-09-20T10:00:00.000Z' },
    });
    expect(h.opened).toEqual([{ id: wire.id, initialCommitMessage: 'Share workspace Team' }]);
  });

  it('answers a taken name with the dialog message and puts everything back', async () => {
    const h = await harness();
    const { id, dir } = await seedLocal(h.root);
    h.server.createFailure = problem(
      'teams-workspace-name-taken',
      'This team already has a workspace with this name.',
      409,
    );

    await expect(
      shareToServer(h.deps, await localInfo(h.root, id), shareRequest({ kind: 'new', name: 'Team' })),
    ).rejects.toMatchObject({
      code: 'teams-workspace-name-taken',
      message: 'A workspace with that name already exists in this team.',
    });

    await expectLocal(dir);
    expect(h.opened).toEqual([{ id }]);
  });

  it('undoes an adoption too when the server fails: same folder, same manifest bytes, same workspace state', async () => {
    const h = await harness();
    const { dir } = await seedLocal(h.root, { id: 'legacy-workspace-1' });
    await h.state.remember('legacy-workspace-1', '2026-09-20T10:00:00.000Z');
    const manifest = await readFile(join(dir, 'workspace.yaml'));
    h.server.createFailure = new WirebenchError('server-unreachable', `Could not reach ${URL_A}`);

    await expect(
      shareToServer(h.deps, await localInfo(h.root, 'legacy-workspace-1'), shareRequest({ kind: 'new', name: 'Team' })),
    ).rejects.toMatchObject({ code: 'server-unreachable' });

    expect(h.server.createAttempts[0]?.body.id).toMatch(TEAMS_ID_PATTERN);
    await expectLocal(dir);
    expect(await readFile(join(dir, 'workspace.yaml'))).toEqual(manifest);
    expect(await readdir(join(h.root, 'workspaces'))).toEqual(['legacy-workspace-1']);
    expect(await h.state.read()).toEqual({
      version: 1,
      lastOpenedWorkspaceId: 'legacy-workspace-1',
      lastOpenedAt: { 'legacy-workspace-1': '2026-09-20T10:00:00.000Z' },
    });
    expect(h.opened).toEqual([{ id: 'legacy-workspace-1' }]);
  });
});

describe('shareToServer — into an existing empty workspace (O1)', () => {
  it('adopts the server workspace’s id and name, keeps its team name, and creates nothing', async () => {
    const h = await harness();
    const { id, dir } = await seedLocal(h.root);
    await h.state.remember(id, '2026-09-20T10:00:00.000Z');
    const staging = h.server.add({ name: 'Staging', role: 'editor' });

    const wire = await shareToServer(
      h.deps,
      await localInfo(h.root, id),
      shareRequest({ kind: 'existing', workspaceId: staging.id }, 'A stale team name'),
    );

    expect(wire.id).toBe(staging.id);
    const adopted = workspaceDir(h.root, staging.id);
    expect(existsSync(dir)).toBe(false);
    expect((await loadWorkspace(join(adopted, 'tree'))).workspace).toMatchObject({ id: staging.id, name: 'Staging' });
    expect((await loadShare(adopted))?.server).toMatchObject({ workspaceId: staging.id, teamName: TEAM_NAME });
    expect(h.server.createAttempts).toEqual([]);
    expect((await h.state.read()).lastOpenedAt).toEqual({ [staging.id]: '2026-09-20T10:00:00.000Z' });
    expect(h.opened).toEqual([{ id: staging.id, initialCommitMessage: 'Share workspace Staging' }]);
  });

  it('refuses a target that filled up, one the caller may only view, one that is gone, and a path-shaped id — before closing', async () => {
    const h = await harness();
    const { id, dir } = await seedLocal(h.root);
    const info = await localInfo(h.root, id);
    const full = h.server.add({ name: 'Full', role: 'editor', files: ONE_FILE });
    const viewOnly = h.server.add({ name: 'Read only', role: 'viewer' });
    const cases: readonly (readonly [string, string])[] = [
      [full.id, 'sync-target-not-empty'],
      [viewOnly.id, 'sync-forbidden'],
      [generateId(), 'teams-workspace-not-found'],
      ['../escape', 'workspace-path-invalid'],
    ];

    for (const [workspaceId, code] of cases) {
      await expect(shareToServer(h.deps, info, shareRequest({ kind: 'existing', workspaceId }))).rejects.toMatchObject({
        code,
      });
    }

    expect(h.closes()).toBe(0);
    await expectLocal(dir);
  });
});

describe('shareToServer — reconnect (O2)', () => {
  it('as an editor of a copy with content: skips creation, keeps the empty base, and opens with the share commit', async () => {
    const h = await harness();
    const { id, dir } = await seedLocal(h.root);
    h.server.add({ id, name: 'Team', role: 'editor', files: await readTreeFiles(dir) });

    const wire = await shareToServer(h.deps, await localInfo(h.root, id), shareRequest({ kind: 'new', name: 'Team' }));

    expect(wire.id).toBe(id);
    expect(h.server.createAttempts).toHaveLength(1);
    expect((await loadShare(dir))?.kind).toBe('server');
    expect((await new ServerState(join(dir, SERVER_STATE_DIR)).read()).base).toEqual({ head: null });
    expect(h.opened).toEqual([{ id, initialCommitMessage: 'Share workspace Team' }]);
  });

  it('refuses a viewer (sync-reconnect-viewer) and a caller with no access (sync-workspace-exists-elsewhere), and puts everything back', async () => {
    const cases = [
      { hidden: false, role: 'viewer', code: 'sync-reconnect-viewer' },
      { hidden: true, role: 'editor', code: 'sync-workspace-exists-elsewhere' },
    ] as const;
    for (const { hidden, role, code } of cases) {
      const h = await harness();
      const { id, dir } = await seedLocal(h.root);
      h.server.add({ id, name: 'Team', role, hidden, files: await readTreeFiles(dir) });

      await expect(
        shareToServer(h.deps, await localInfo(h.root, id), shareRequest({ kind: 'new', name: 'Team' })),
      ).rejects.toMatchObject({ code });

      await expectLocal(dir);
      expect(h.opened).toEqual([{ id }]);
    }
  });
});

describe('shareToServer — refused before anything moves', () => {
  it('refuses a leftover tree/.git, a linked project, a server without sync and a signed-out account without closing the workspace', async () => {
    const h = await harness();
    const request = shareRequest({ kind: 'new', name: 'Team' });

    const leftover = await seedLocal(h.root);
    await mkdir(join(leftover.dir, 'tree', '.git'), { recursive: true });
    await expect(shareToServer(h.deps, await localInfo(h.root, leftover.id), request)).rejects.toMatchObject({
      code: 'workspace-git-leftover',
    });

    const linked = await seedLocal(h.root, { linked: true });
    await expect(shareToServer(h.deps, await localInfo(h.root, linked.id), request)).rejects.toMatchObject({
      code: 'share-linked-project-refused',
    });

    const plain = await seedLocal(h.root);
    h.server.capabilities = [];
    await expect(shareToServer(h.deps, await localInfo(h.root, plain.id), request)).rejects.toMatchObject({
      code: 'sync-not-supported-by-server',
      message: 'This server is too old to sync workspaces.',
    });

    const signedOut = await harness({ signedIn: false });
    const theirs = await seedLocal(signedOut.root);
    const signedOutInfo = await localInfo(signedOut.root, theirs.id);
    await expect(shareToServer(signedOut.deps, signedOutInfo, request)).rejects.toMatchObject({
      code: 'account-signed-out',
    });

    expect(h.closes() + signedOut.closes()).toBe(0);
    expect([...h.server.createAttempts, ...signedOut.server.createAttempts]).toEqual([]);
    await expectLocal(plain.dir);
  });
});

describe('joinFromServer (§3.4 Open a team workspace)', () => {
  it('downloads the snapshot into <id>/tree, writes share.yaml and the base at the head with the role, and opens it', async () => {
    const h = await harness();
    const copy = await serverCopy();
    const row = h.server.add({ id: copy.id, name: 'Team', role: 'viewer', files: copy.files });

    const wire = await joinFromServer(h.deps, { url: URL_A, workspaceId: row.id });

    const dir = workspaceDir(h.root, row.id);
    expect(wire.id).toBe(row.id);
    expect((await loadWorkspace(join(dir, 'tree'))).workspace.id).toBe(row.id);
    expect(existsSync(join(dir, 'tree', 'projects', 'Calc', 'wirebench.yaml'))).toBe(true);
    expect(await loadShare(dir)).toEqual({
      version: 1,
      kind: 'server',
      server: {
        url: URL_A,
        workspaceId: row.id,
        teamName: TEAM_NAME,
        autoFetchSeconds: 60,
        commitOnSave: true,
        pushOnSave: true,
      },
    });
    const state = new ServerState(join(dir, SERVER_STATE_DIR));
    expect(await state.read()).toMatchObject({
      base: { head: h.server.headOf(row.id) },
      role: 'viewer',
      identity: { name: 'Ada Lovelace', email: 'ada@example.com' },
    });
    expect(await state.baseFiles()).toEqual(copy.files);
    expect(await readdir(join(h.root, 'workspaces', '.joining'))).toEqual([]);
    expect(h.opened).toEqual([{ id: row.id }]);
  });

  it('refuses an id mismatch, an id already here, an empty workspace and one it cannot see, leaving nothing behind', async () => {
    const h = await harness();
    const copy = await serverCopy();
    const mismatched = h.server.add({ name: 'Renamed elsewhere', files: copy.files });
    const present = await seedLocal(h.root);
    const presentCopy = await serverCopy({ id: present.id });
    const here = h.server.add({ id: present.id, name: 'Team', files: presentCopy.files });
    const empty = h.server.add({ name: 'Empty' });
    const hidden = h.server.add({ name: 'Hidden', hidden: true, files: copy.files });
    const cases: readonly (readonly [string, string])[] = [
      [mismatched.id, 'sync-workspace-id-mismatch'],
      [here.id, 'workspace-already-present'],
      [empty.id, 'workspace-not-found'],
      [hidden.id, 'teams-workspace-not-found'],
    ];

    for (const [workspaceId, code] of cases) {
      await expect(joinFromServer(h.deps, { url: URL_A, workspaceId })).rejects.toMatchObject({ code });
    }

    expect((await readdir(join(h.root, 'workspaces'))).sort()).toEqual(['.joining', present.id].sort());
    expect(await readdir(join(h.root, 'workspaces', '.joining'))).toEqual([]);
    await expectLocal(present.dir);
    expect(h.opened).toEqual([]);
  });

  it('checks the id before any call, and the sync capability before any download', async () => {
    const h = await harness();
    await expect(joinFromServer(h.deps, { url: URL_A, workspaceId: '../../etc' })).rejects.toMatchObject({
      code: 'workspace-path-invalid',
    });
    expect(h.server.calls).toEqual([]);

    h.server.capabilities = [];
    const copy = await serverCopy();
    h.server.add({ id: copy.id, name: 'Team', files: copy.files });
    await expect(joinFromServer(h.deps, { url: URL_A, workspaceId: copy.id })).rejects.toMatchObject({
      code: 'sync-not-supported-by-server',
    });
    expect(h.server.calls).toEqual(['meta']);
  });
});

describe('stopSharing — a server share', () => {
  it('moves the tree back, deletes server/, keeps the server copy and never calls the server', async () => {
    const h = await harness();
    const { id, dir } = await seedLocal(h.root);
    await shareToServer(h.deps, await localInfo(h.root, id), shareRequest({ kind: 'new', name: 'Team' }));
    const share = await loadShare(dir);
    const { workspace } = await loadWorkspace(join(dir, 'tree'));
    h.server.calls.splice(0);

    const wire = await stopSharing(h.deps, { workspace, dir, tree: join(dir, 'tree'), share });

    expect(wire.id).toBe(id);
    expect(existsSync(join(dir, 'workspace.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'projects', 'Calc', 'wirebench.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'share.yaml'))).toBe(false);
    expect(existsSync(join(dir, SERVER_STATE_DIR))).toBe(false);
    expect(h.server.calls).toEqual([]);
    expect(h.server.has(id)).toBe(true);
  });
});

describe('the dialogs’ lists', () => {
  it('serverShareTargets lists the team’s empty workspaces the caller can edit, and nothing else', async () => {
    const h = await harness();
    const editable = h.server.add({ name: 'Staging', role: 'editor' });
    const administered = h.server.add({ name: 'Scratch', role: 'admin' });
    h.server.add({ name: 'Read only', role: 'viewer' });
    h.server.add({ name: 'Full', role: 'admin', files: ONE_FILE });
    h.server.add({ name: 'Other team', role: 'admin', teamId: generateId() });

    const targets = await serverShareTargets(h.deps, { url: URL_A, teamId: TEAM_ID });

    expect(targets.map((row) => row.id).sort()).toEqual([editable.id, administered.id].sort());
  });

  it('openableTeamWorkspaces hides empty workspaces, skips a failing server while another answers, and fails when all do', async () => {
    const h = await harness();
    const full = h.server.add({ name: 'Payments', role: 'viewer', files: ONE_FILE });
    h.server.add({ name: 'Staging', role: 'editor' });

    expect(await openableTeamWorkspaces(h.deps, [URL_A, URL_B])).toEqual([{ url: URL_A, workspace: full }]);
    await expect(openableTeamWorkspaces(h.deps, [URL_B])).rejects.toMatchObject({ code: 'account-signed-out' });
    expect(await openableTeamWorkspaces(h.deps, [])).toEqual([]);
  });
});

describe('WorkspaceService — shareToServer end to end', { timeout: 30_000 }, () => {
  async function newService(
    server: StubServer,
    hooks: WorkspaceHooks = {},
  ): Promise<{ readonly root: string; readonly service: WorkspaceService }> {
    serial += 1;
    const root = join(base, `service-${String(serial)}`);
    await mkdir(root, { recursive: true });
    const service = new WorkspaceService({
      userDataDir: root,
      engine: new EngineService(),
      history: new HistoryService(root),
      picks: new DialogPicks(),
      hooks,
      server: {
        client: server as unknown as ServerClient,
        accounts: { ...accountsFor(true), onChange: () => () => undefined, ready: Promise.resolve() },
      },
    });
    services.push(service);
    return { root, service };
  }

  it('a new share pushes its first commit to the server', async () => {
    const server = new StubServer();
    const { service } = await newService(server);
    const created = await service.create('Team');
    await service.addProject('Calc');

    const wire = await service.shareToServer(shareRequest({ kind: 'new', name: 'Team' }));

    expect(wire.share?.kind).toBe('server');
    expect(server.pushes).toEqual([{ parent: null, accepted: true }]);
    expect([...server.filesOf(created.id).keys()]).toContain('workspace.yaml');
    expect(service.syncStatus()).toMatchObject({ kind: 'server', ahead: 0 });
  });

  it('a reconnect as editor merges over the empty base: the rejected push pulls, and the differing workspace.yaml is a conflict', async () => {
    const server = new StubServer();
    const onSyncConflict = vi.fn<(workspaceId: string, conflicts: readonly SyncConflictWire[]) => void>();
    const { root, service } = await newService(server, { onSyncConflict });
    const created = await service.create('Team');
    await service.addProject('Calc');
    const theirs = await readTreeFiles(workspaceDir(root, created.id));
    const manifest = theirs.get('workspace.yaml')?.content ?? '';
    const changed = manifest.replace(/^name: Team$/m, 'name: Team on the server');
    expect(changed).not.toBe(manifest);
    theirs.set('workspace.yaml', { encoding: 'utf8', content: changed });
    server.add({ id: created.id, name: 'Team', role: 'editor', files: theirs });

    await service.shareToServer(shareRequest({ kind: 'new', name: 'Team' }));

    await vi.waitFor(() => {
      expect(onSyncConflict).toHaveBeenCalled();
    }, WAIT);
    expect(onSyncConflict.mock.calls.flatMap(([, conflicts]) => conflicts.map((conflict) => conflict.path))).toEqual([
      'workspace.yaml',
    ]);
    expect(server.createAttempts).toHaveLength(1);
    expect(server.pushes.length).toBeGreaterThan(0);
    expect(server.pushes.every((push) => push.parent === null && !push.accepted)).toBe(true);
    expect(service.syncStatus().state).toBe('conflict');
  });
});
