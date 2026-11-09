// @vitest-environment node
/**
 * `WorkspaceService` wiring for a Wirebench Server share (server-sync spec §3.4, §5.3, R6):
 * - the sync of a server workspace waits for the accounts to load before its first call;
 * - it resumes when its account is signed in again;
 * - it takes the three sync settings, and never a remote or a branch.
 *
 * The server is a scripted `send` behind the desktop's real `ServerClient`. The backend is the real
 * `ServerBackend`, over a base that already holds the tree, so opening has nothing to commit.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkspace,
  DEFAULT_SYNC_SETTINGS,
  loadShare,
  loadWorkspace,
  saveShare,
  saveWorkspace,
  workspaceDir,
} from '@wirebench/engine';
import type { HttpExchange, HttpRequest, ServerAccount } from '@wirebench/engine';
import type { LiveEvent } from '../src/live/live-client.js';
import { EngineService } from '../src/engine-service.js';
import { HistoryService } from '../src/history-service.js';
import { ServerClient } from '../src/server-client.js';
import { readTreeFiles, SERVER_STATE_DIR, ServerState } from '../src/sync/server-state.js';
import { SyncService } from '../src/sync/sync-service.js';
import { WorkspaceService } from '../src/workspace-service.js';
import type { WorkspaceServiceDeps } from '../src/workspace-service.js';
import type { AuditTarget } from '../src/audit/reporter.js';
import type { WorkspaceWire } from '@wirebench/wire/wire-base';
import { createHostState } from '../src/host/host-state.js';

const hostState = createHostState();

const SERVER_URL = 'https://wb.test';
const HEAD = 'a'.repeat(40);
const TOKEN = `wbs_${'A'.repeat(43)}`;
const WAIT = { timeout: 5_000, interval: 20 };
const settle = (ms = 100): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let root: string;
const services: WorkspaceService[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wirebench-server-sync-'));
});

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.close();
  }
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function json(status: number, body: unknown): HttpExchange {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    request: { url: '', method: 'GET', headers: {} },
    status,
    statusText: '',
    headers: { 'content-type': 'application/json' },
    rawHeaders: [],
    body: bytes,
    rawBody: bytes,
  } as unknown as HttpExchange;
}

/**
 * A server that knows the two reads a fetch may make: `GET …/sync/head`, answering this head and
 * `role`, and `GET …/sync/log`, which is empty. Anything else is a 404.
 */
function scriptedServer(
  role: 'viewer' | 'editor' = 'editor',
  recordDesktopActivity = false,
  more: {
    /** The names the head reports; none, as an older server. */
    readonly names?: { name?: string; teamName?: string };
    /** Answers anything else first; `undefined` falls through. */
    readonly answer?: (request: HttpRequest, path: string) => HttpExchange | undefined;
  } = {},
): { sent: HttpRequest[]; client: ServerClient } {
  const sent: HttpRequest[] = [];
  const send = (request: HttpRequest): Promise<HttpExchange> => {
    sent.push(request);
    const path = new URL(request.url).pathname;
    const answered = more.answer?.(request, path);
    if (answered !== undefined) {
      return Promise.resolve(answered);
    }
    if (path.endsWith('/sync/head')) {
      return Promise.resolve(
        json(200, { head: HEAD, commits: 1, behind: 0, role, recordDesktopActivity, ...more.names }),
      );
    }
    if (path.endsWith('/sync/log')) {
      return Promise.resolve(json(200, []));
    }
    return Promise.resolve(json(404, { code: 'not-found', message: `No route for ${path}` }));
  };
  return { sent, client: new ServerClient({ send }) };
}

const headPath = (id: string): string => `/api/v1/workspaces/${id}/sync/head`;
const pathsOf = (sent: readonly HttpRequest[]): string[] => sent.map((request) => new URL(request.url).pathname);

type Accounts = NonNullable<WorkspaceServiceDeps['server']>['accounts'];

/** The slice of `AccountService` the workspace service uses, driven by hand. */
function fakeAccounts(options: { readonly loaded?: boolean } = {}): {
  readonly accounts: Accounts;
  readonly state: { token: string | undefined };
  finishLoading(): void;
  emit(servers: readonly ServerAccount[]): void;
} {
  let finish = (): void => undefined;
  const ready =
    options.loaded === false
      ? new Promise<void>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve();
  const listeners = new Set<(servers: readonly ServerAccount[]) => void>();
  const state: { token: string | undefined } = { token: TOKEN };
  return {
    state,
    finishLoading: () => {
      finish();
    },
    emit: (servers) => {
      for (const listener of listeners) listener(servers);
    },
    accounts: {
      ready,
      tokenFor: () => Promise.resolve(state.token),
      markSignedOut: () => undefined,
      list: () => [],
      active: () => null,
      onChange: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
}

function account(overrides: Partial<ServerAccount> = {}): ServerAccount {
  return {
    url: SERVER_URL,
    userId: '01J8Z0000000000000000000AB',
    email: 'ada@example.test',
    displayName: 'Ada',
    deviceName: 'laptop',
    tokenRef: `sec_${'0'.repeat(26)}`,
    addedAt: '2026-09-25T00:00:00.000Z',
    ...overrides,
  };
}

function newService(
  server: NonNullable<WorkspaceServiceDeps['server']>,
  hooks?: WorkspaceServiceDeps['hooks'],
): WorkspaceService {
  const service = new WorkspaceService({
    hostState,
    userDataDir: root,
    engine: new EngineService(),
    history: new HistoryService(root, hostState.redactor),
    server,
    ...(hooks !== undefined ? { hooks } : {}),
  });
  services.push(service);
  return service;
}

/** A server-shared workspace whose base already holds its tree at `HEAD`: nothing to commit on open. */
async function seedServerWorkspace(): Promise<{ id: string; dir: string }> {
  const workspace = createWorkspace('Payments QA');
  const dir = workspaceDir(root, workspace.id);
  const tree = join(dir, 'tree');
  await mkdir(tree, { recursive: true });
  await saveWorkspace(workspace, tree);
  await saveShare(dir, {
    version: 1,
    kind: 'server',
    server: {
      ...DEFAULT_SYNC_SETTINGS,
      autoFetchSeconds: 0,
      url: SERVER_URL,
      workspaceId: workspace.id,
      teamName: 'Payments',
    },
  });
  await ServerState.initialize(join(dir, SERVER_STATE_DIR), HEAD, await readTreeFiles(tree));
  return { id: workspace.id, dir };
}

it('waits for the accounts to load before a server workspace makes its first call', async () => {
  const server = scriptedServer();
  const fake = fakeAccounts({ loaded: false });
  const service = newService({ client: server.client, accounts: fake.accounts });
  const { id } = await seedServerWorkspace();

  await service.open(id);
  await settle();
  expect(service.sync()).toBeUndefined();
  expect(server.sent).toEqual([]);

  fake.finishLoading();
  await vi.waitFor(
    () =>
      expect(service.syncStatus()).toMatchObject({
        kind: 'server',
        state: 'clean',
        role: 'editor',
        remote: SERVER_URL,
      }),
    WAIT,
  );
  expect(pathsOf(server.sent)[0]).toBe(headPath(id));
});

it('a signed-out server workspace shows sync-signed-out, and resumes once its account is signed in', async () => {
  const server = scriptedServer();
  const fake = fakeAccounts();
  fake.state.token = undefined;
  const resume = vi.spyOn(SyncService.prototype, 'resume');
  const service = newService({ client: server.client, accounts: fake.accounts });
  const { id } = await seedServerWorkspace();

  await service.open(id);
  await vi.waitFor(
    () => expect(service.syncStatus()).toMatchObject({ state: 'error', error: { code: 'sync-signed-out' } }),
    WAIT,
  );
  expect(server.sent).toEqual([]);

  // Another server's account, or this one still signed out: no reason to try again.
  fake.emit([account({ url: 'https://other.test' }), account({ signedOut: true })]);
  expect(resume).not.toHaveBeenCalled();

  fake.state.token = TOKEN;
  fake.emit([account()]);
  expect(resume).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(service.syncStatus()).toMatchObject({ state: 'clean', role: 'editor' }), WAIT);
  expect(pathsOf(server.sent)).toContain(headPath(id));
});

it('reads a viewer role from the fetch into the status', async () => {
  const server = scriptedServer('viewer');
  const service = newService({ client: server.client, accounts: fakeAccounts().accounts });
  const { id } = await seedServerWorkspace();

  await service.open(id);

  await vi.waitFor(() => expect(service.syncStatus()).toMatchObject({ kind: 'server', role: 'viewer' }), WAIT);
  await expect(service.sync()?.push()).rejects.toMatchObject({ code: 'sync-forbidden' });
  expect(server.sent.every((request) => request.method === 'GET')).toBe(true);
});

it("keeps a fetched head's recordDesktopActivity: the audit target, the share and the stored state carry it", async () => {
  const server = scriptedServer('editor', true);
  const targets: { target: AuditTarget | undefined; fetched: boolean }[] = [];
  const changed: (WorkspaceWire | null)[] = [];
  const service = newService(
    { client: server.client, accounts: fakeAccounts().accounts },
    {
      onAuditTarget: (target, fetched) => targets.push({ target, fetched }),
      onChanged: (workspace) => changed.push(workspace),
    },
  );
  const { id, dir } = await seedServerWorkspace();

  await service.open(id);

  const recording: AuditTarget = {
    url: SERVER_URL,
    workspaceId: id,
    dir: join(dir, SERVER_STATE_DIR, 'audit-outbox'),
    recording: true,
    role: 'editor',
  };
  await vi.waitFor(() => expect(service.auditTarget()).toEqual(recording), WAIT);
  expect(service.snapshot()?.share?.server).toEqual({
    url: SERVER_URL,
    workspaceId: id,
    teamName: 'Payments',
    recording: true,
  });
  // The renderer hears of it: a workspace change whose share records.
  expect(changed.at(-1)?.share?.server?.recording).toBe(true);
  expect((await new ServerState(join(dir, SERVER_STATE_DIR)).read()).recordDesktopActivity).toBe(true);
  // Opened first (not yet recording), then the fetch that said so.
  expect(targets[0]).toEqual({ target: { ...recording, recording: false, role: undefined }, fetched: false });
  expect(targets.at(-1)).toEqual({ target: recording, fetched: true });

  await service.close();
  expect(targets.at(-1)).toEqual({ target: undefined, fetched: false });
});

it('records from the stored flag on open, before any fetch', async () => {
  const server = scriptedServer();
  const service = newService({ client: server.client, accounts: fakeAccounts({ loaded: false }).accounts });
  const { id, dir } = await seedServerWorkspace();
  await new ServerState(join(dir, SERVER_STATE_DIR)).update({ recordDesktopActivity: true });

  await service.open(id);

  expect(service.auditTarget()).toMatchObject({ workspaceId: id, recording: true });
  expect(service.snapshot()?.share?.server?.recording).toBe(true);
  expect(server.sent).toEqual([]);
});

it('a local workspace has no audit target', async () => {
  const service = newService({ client: scriptedServer().client, accounts: fakeAccounts().accounts });
  const created = await service.create('Local');
  expect(created.share).toBeUndefined();
  expect(service.auditTarget()).toBeUndefined();
});

it('takes the three sync settings for a server share, and refuses a remote or a branch', async () => {
  const server = scriptedServer();
  const service = newService({ client: server.client, accounts: fakeAccounts().accounts });
  const { id, dir } = await seedServerWorkspace();
  await service.open(id);
  await vi.waitFor(() => expect(service.sync()).toBeDefined(), WAIT);

  expect(service.snapshot()?.share).toEqual({
    kind: 'server',
    managed: true,
    server: { url: SERVER_URL, workspaceId: id, teamName: 'Payments', recording: false },
    autoFetchSeconds: 0,
    commitOnSave: true,
    pushOnSave: true,
  });

  await service.updateSyncSettings({ autoFetchSeconds: 120, pushOnSave: false });

  expect((await loadShare(dir))?.server).toEqual({
    url: SERVER_URL,
    workspaceId: id,
    teamName: 'Payments',
    autoFetchSeconds: 120,
    commitOnSave: true,
    pushOnSave: false,
  });
  expect(service.snapshot()?.share).toMatchObject({ autoFetchSeconds: 120, pushOnSave: false });

  for (const patch of [{ remote: 'https://example.test/team.git' }, { branch: 'main' }]) {
    await expect(service.updateSyncSettings(patch)).rejects.toMatchObject({ code: 'sync-not-supported' });
  }
  expect((await loadShare(dir))?.server?.autoFetchSeconds).toBe(120);
});

it('close waits for a push already in flight, so a reopen never shares the sync state with it (I1)', async () => {
  const sent: HttpRequest[] = [];
  let answerPush!: () => void;
  const pushAnswered = new Promise<void>((resolve) => {
    answerPush = resolve;
  });
  const PUSHED = 'b'.repeat(40);
  const send = async (request: HttpRequest): Promise<HttpExchange> => {
    sent.push(request);
    const path = new URL(request.url).pathname;
    if (path.endsWith('/sync/head'))
      return json(200, { head: HEAD, commits: 1, behind: 0, role: 'editor', recordDesktopActivity: false });
    if (path.endsWith('/sync/commits')) {
      await pushAnswered;
      return json(201, { head: PUSHED, ids: [PUSHED] });
    }
    return json(404, { code: 'not-found', message: `No route for ${path}` });
  };
  const service = newService({ client: new ServerClient({ send }), accounts: fakeAccounts().accounts });
  const { id, dir } = await seedServerWorkspace();
  // A commit an earlier session never pushed: opening pushes it.
  await new ServerState(join(dir, SERVER_STATE_DIR)).appendPending({
    subject: 'Waiting',
    at: '2026-09-25T00:00:00.000Z',
    changes: [{ path: 'environments/qa.yaml', encoding: 'utf8', content: 'name: QA\n' }],
  });

  await service.open(id);
  await vi.waitFor(() => expect(pathsOf(sent).some((path) => path.endsWith('/sync/commits'))).toBe(true), WAIT);

  let closed = false;
  const closing = service.close().then(() => {
    closed = true;
  });
  await settle(200);
  expect(closed).toBe(false);

  answerPush();
  await closing;
  const state = new ServerState(join(dir, SERVER_STATE_DIR));
  expect(await state.pending()).toEqual([]);
  expect((await state.read()).base.head).toBe(PUSHED);
});

describe("the server's name wins", () => {
  /** The team workspace row a `PATCH /workspaces/:id` answers, under `name`. */
  const row = (id: string, name: string): unknown => ({
    id,
    name,
    teamId: '01J8Z0000000000000000000TT',
    teamName: 'Payments',
    defaultRole: 'viewer',
    myRole: 'admin',
    source: 'team-admin',
    createdAt: '2026-09-25T00:00:00.000Z',
  });
  const bodyOf = (request: HttpRequest): unknown => JSON.parse(new TextDecoder().decode(request.body)) as unknown;
  const manifestName = async (dir: string): Promise<string> => (await loadWorkspace(join(dir, 'tree'))).workspace.name;

  it('a fetch that reports new names reaches the snapshot, the list and share.yaml, and never workspace.yaml', async () => {
    const server = scriptedServer('editor', false, { names: { name: 'Payments EU', teamName: 'Payments Team' } });
    const changed: (WorkspaceWire | null)[] = [];
    const service = newService(
      { client: server.client, accounts: fakeAccounts().accounts },
      { onChanged: (workspace) => changed.push(workspace) },
    );
    const { id, dir } = await seedServerWorkspace();

    await service.open(id);
    expect(service.snapshot()?.name).toBe('Payments QA');

    await vi.waitFor(() => expect(service.snapshot()?.name).toBe('Payments EU'), WAIT);
    expect(service.snapshot()?.share?.server?.teamName).toBe('Payments Team');
    // The renderer hears of it, so the title bar changes without a reopen.
    expect(changed.at(-1)).toMatchObject({ name: 'Payments EU', share: { server: { teamName: 'Payments Team' } } });
    expect((await loadShare(dir))?.server).toMatchObject({ name: 'Payments EU', teamName: 'Payments Team' });
    expect((await new ServerState(join(dir, SERVER_STATE_DIR)).read()).name).toBe('Payments EU');
    expect((await service.list()).find((summary) => summary.id === id)?.name).toBe('Payments EU');
    expect(await manifestName(dir)).toBe('Payments QA');
  });

  it("a live access after a rename elsewhere fetches the new name into the open window's snapshot", async () => {
    const names: { name?: string; teamName?: string } = {};
    const server = scriptedServer('editor', false, { names });
    const listeners: ((event: LiveEvent) => void)[] = [];
    const live = {
      subscribe: (_url: string, _workspaceId: string, listener: (event: LiveEvent) => void) => {
        listeners.push(listener);
        return () => undefined;
      },
    };
    const changed: (WorkspaceWire | null)[] = [];
    const service = newService(
      { client: server.client, accounts: fakeAccounts().accounts, live },
      { onChanged: (workspace) => changed.push(workspace) },
    );
    const { id } = await seedServerWorkspace();
    await service.open(id);
    await vi.waitFor(() => expect(service.syncStatus()).toMatchObject({ state: 'clean' }), WAIT);
    await vi.waitFor(() => expect(listeners).toHaveLength(1), WAIT);
    const heads = (): number => pathsOf(server.sent).filter((path) => path === headPath(id)).length;
    const before = heads();

    // Renamed in Team settings: no timer runs (autoFetchSeconds 0), only the live nudge.
    names.name = 'Payments renamed';
    for (const listener of listeners) listener({ kind: 'message', message: { type: 'access', workspaceId: id } });

    await vi.waitFor(() => expect(service.snapshot()?.name).toBe('Payments renamed'), WAIT);
    expect(heads()).toBe(before + 1);
    expect(changed.at(-1)?.name).toBe('Payments renamed');
  });

  it("an older server's head names nothing: the tree's name stays", async () => {
    const server = scriptedServer();
    const service = newService({ client: server.client, accounts: fakeAccounts().accounts });
    const { id, dir } = await seedServerWorkspace();

    await service.open(id);
    await vi.waitFor(() => expect(service.syncStatus()).toMatchObject({ state: 'clean' }), WAIT);
    await settle();

    expect(service.snapshot()?.name).toBe('Payments QA');
    expect((await loadShare(dir))?.server?.name).toBeUndefined();
  });

  it('the list shows a closed server workspace under the name its share keeps', async () => {
    const service = newService({ client: scriptedServer().client, accounts: fakeAccounts().accounts });
    const { id, dir } = await seedServerWorkspace();
    const share = (await loadShare(dir))!;
    await saveShare(dir, { ...share, server: { ...share.server!, name: 'Payments EU' } });

    expect((await service.list()).find((summary) => summary.id === id)?.name).toBe('Payments EU');
  });

  it('renaming the open workspace renames it on the server first, and keeps the name the server answers', async () => {
    let id = '';
    const server = scriptedServer('editor', false, {
      answer: (request, path) =>
        request.method === 'PATCH' && path === `/api/v1/workspaces/${id}`
          ? json(200, row(id, 'Payments EU'))
          : undefined,
    });
    const changed: (WorkspaceWire | null)[] = [];
    const service = newService(
      { client: server.client, accounts: fakeAccounts().accounts },
      { onChanged: (workspace) => changed.push(workspace) },
    );
    const seeded = await seedServerWorkspace();
    id = seeded.id;
    await service.open(id);

    await service.rename(id, ' Payments EU ');

    const patch = server.sent.find((request) => request.method === 'PATCH');
    expect(bodyOf(patch!)).toEqual({ name: ' Payments EU ' });
    expect(patch?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(service.snapshot()?.name).toBe('Payments EU');
    expect(changed.at(-1)?.name).toBe('Payments EU');
    expect((await loadShare(seeded.dir))?.server?.name).toBe('Payments EU');
    // The tree follows, for anything that reads workspace.yaml alone.
    expect(await manifestName(seeded.dir)).toBe('Payments EU');
  });

  it('the rename-workspace change renames it on the server too', async () => {
    let id = '';
    const server = scriptedServer('editor', false, {
      answer: (request, path) =>
        request.method === 'PATCH' && path === `/api/v1/workspaces/${id}` ? json(200, row(id, 'Renamed')) : undefined,
    });
    const service = newService({ client: server.client, accounts: fakeAccounts().accounts });
    const seeded = await seedServerWorkspace();
    id = seeded.id;
    await service.open(id);

    const { workspace } = await service.mutate({ kind: 'rename-workspace', name: 'Renamed' });

    expect(workspace.name).toBe('Renamed');
    expect(server.sent.filter((request) => request.method === 'PATCH')).toHaveLength(1);
    expect((await loadShare(seeded.dir))?.server?.name).toBe('Renamed');
  });

  it("a rename the server refuses throws the server's error and changes nothing", async () => {
    const forbidden = { code: 'teams-forbidden', message: 'Only a workspace admin can do that.' };
    const server = scriptedServer('editor', false, {
      answer: (request) => (request.method === 'PATCH' ? json(403, forbidden) : undefined),
    });
    const service = newService({ client: server.client, accounts: fakeAccounts().accounts });
    const { id, dir } = await seedServerWorkspace();
    await service.open(id);

    await expect(service.rename(id, 'Mine now')).rejects.toMatchObject(forbidden);
    await expect(service.mutate({ kind: 'rename-workspace', name: 'Mine now' })).rejects.toMatchObject(forbidden);

    expect(service.snapshot()?.name).toBe('Payments QA');
    expect(await manifestName(dir)).toBe('Payments QA');
    expect((await loadShare(dir))?.server?.name).toBeUndefined();
  });

  it('renaming a closed server workspace renames it on the server too', async () => {
    let id = '';
    const server = scriptedServer('editor', false, {
      answer: (request, path) =>
        request.method === 'PATCH' && path === `/api/v1/workspaces/${id}` ? json(200, row(id, 'Closed EU')) : undefined,
    });
    const service = newService({ client: server.client, accounts: fakeAccounts().accounts });
    const seeded = await seedServerWorkspace();
    id = seeded.id;

    const rows = await service.rename(id, 'Closed EU');

    expect(rows.find((summary) => summary.id === id)?.name).toBe('Closed EU');
    expect((await loadShare(seeded.dir))?.server?.name).toBe('Closed EU');
    expect(await manifestName(seeded.dir)).toBe('Closed EU');
  });
});
