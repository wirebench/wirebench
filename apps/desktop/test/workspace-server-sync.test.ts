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
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createWorkspace,
  DEFAULT_SYNC_SETTINGS,
  loadShare,
  saveShare,
  saveWorkspace,
  workspaceDir,
} from '@wirebench/engine';
import type { HttpExchange, HttpRequest, ServerAccount } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService } from '../src/main/history-service.js';
import { ServerClient } from '../src/main/server-client.js';
import { readTreeFiles, SERVER_STATE_DIR, ServerState } from '../src/main/sync/server-state.js';
import { SyncService } from '../src/main/sync/sync-service.js';
import { WorkspaceService } from '../src/main/workspace-service.js';
import type { WorkspaceServiceDeps } from '../src/main/workspace-service.js';

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
function scriptedServer(role: 'viewer' | 'editor' = 'editor'): { sent: HttpRequest[]; client: ServerClient } {
  const sent: HttpRequest[] = [];
  const send = (request: HttpRequest): Promise<HttpExchange> => {
    sent.push(request);
    const path = new URL(request.url).pathname;
    if (path.endsWith('/sync/head')) {
      return Promise.resolve(json(200, { head: HEAD, commits: 1, behind: 0, role }));
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

function newService(server: NonNullable<WorkspaceServiceDeps['server']>): WorkspaceService {
  const service = new WorkspaceService({
    userDataDir: root,
    engine: new EngineService(),
    history: new HistoryService(root),
    server,
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

it('takes the three sync settings for a server share, and refuses a remote or a branch', async () => {
  const server = scriptedServer();
  const service = newService({ client: server.client, accounts: fakeAccounts().accounts });
  const { id, dir } = await seedServerWorkspace();
  await service.open(id);
  await vi.waitFor(() => expect(service.sync()).toBeDefined(), WAIT);

  expect(service.snapshot()?.share).toEqual({
    kind: 'server',
    managed: true,
    server: { url: SERVER_URL, workspaceId: id, teamName: 'Payments' },
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
