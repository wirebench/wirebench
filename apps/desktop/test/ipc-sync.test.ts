// @vitest-environment node
/**
 * `sync.*` channels, through the handler-capture pattern: every channel is registered against a
 * fake `WorkspaceService`/`SyncService`, invoked with a raw payload exactly as the preload would
 * send it, and checked for what it forwarded and what envelope came back.
 */
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import { registerSyncChannels } from '../src/main/ipc/sync.js';
import type { SyncService } from '../src/main/sync/sync-service.js';
import { channels } from '../src/shared/ipc.js';
import type { SyncStatusWire } from '../src/shared/wire-types.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const SENDER = { id: 42 };

type Envelope = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };

function invoke(channel: string, payload?: unknown): Promise<Envelope> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: SENDER }, payload) as Promise<Envelope>;
}

const SHARED_STATUS: SyncStatusWire = {
  kind: 'git',
  gitAvailable: true,
  state: 'clean',
  ahead: 0,
  behind: 0,
  uncommitted: 0,
  remote: 'https://example.test/repo.git',
  branch: 'main',
};

const LOCAL_STATUS: SyncStatusWire = {
  kind: 'local',
  gitAvailable: true,
  state: 'clean',
  ahead: 0,
  behind: 0,
  uncommitted: 0,
};

/** A `SyncService` double: every method resolves to a valid wire value and is spied on. */
function fakeSyncService() {
  return {
    status: vi.fn().mockReturnValue(SHARED_STATUS),
    fetch: vi.fn().mockResolvedValue(SHARED_STATUS),
    pull: vi.fn().mockResolvedValue(SHARED_STATUS),
    push: vi.fn().mockResolvedValue(SHARED_STATUS),
    commit: vi.fn().mockResolvedValue(SHARED_STATUS),
    conflicts: vi.fn().mockResolvedValue([{ path: 'projects/calc/requests/r1.request.yaml' }]),
    resolve: vi.fn().mockResolvedValue(SHARED_STATUS),
    abortMerge: vi.fn().mockResolvedValue(SHARED_STATUS),
    log: vi.fn().mockResolvedValue([{ id: 'c1', subject: 'Save', author: 'a', at: '2026-09-13T00:00:00.000Z' }]),
    setIdentity: vi.fn().mockResolvedValue(undefined),
  };
}

const TREE = '/user-data/workspaces/w1/tree';

let sync: ReturnType<typeof fakeSyncService> | undefined;
let service: {
  sync: () => SyncService | undefined;
  syncStatus: ReturnType<typeof vi.fn<() => SyncStatusWire>>;
  treeDir: ReturnType<typeof vi.fn<() => string>>;
  updateSyncSettings: ReturnType<typeof vi.fn<(patch: unknown) => Promise<SyncStatusWire>>>;
};
let reveal: ReturnType<typeof vi.fn<(path: string) => void>>;

beforeEach(() => {
  handlers.clear();
  sync = fakeSyncService();
  service = {
    sync: () => sync as unknown as SyncService | undefined,
    syncStatus: vi.fn<() => SyncStatusWire>().mockReturnValue(SHARED_STATUS),
    treeDir: vi.fn<() => string>().mockReturnValue(TREE),
    updateSyncSettings: vi.fn<(patch: unknown) => Promise<SyncStatusWire>>().mockResolvedValue(SHARED_STATUS),
  };
  reveal = vi.fn<(path: string) => void>();
  registerSyncChannels({ service, reveal });
});

describe('sync.* channels', () => {
  it('registers every channel the contract declares', () => {
    const declared = Object.values(channels.sync).map((channel) => channel.name);
    expect([...handlers.keys()].sort()).toEqual([...declared].sort());
  });

  it('status answers through the service, never the running sync directly', async () => {
    await expect(invoke('sync.status')).resolves.toEqual({ ok: true, value: SHARED_STATUS });
    expect(service.syncStatus).toHaveBeenCalled();
  });

  it('fetch/pull/push route to the running sync service', async () => {
    await expect(invoke('sync.fetch')).resolves.toEqual({ ok: true, value: SHARED_STATUS });
    expect(sync?.fetch).toHaveBeenCalled();
    await expect(invoke('sync.pull')).resolves.toEqual({ ok: true, value: SHARED_STATUS });
    expect(sync?.pull).toHaveBeenCalled();
    await expect(invoke('sync.push')).resolves.toEqual({ ok: true, value: SHARED_STATUS });
    expect(sync?.push).toHaveBeenCalled();
  });

  it('commit forwards an optional message', async () => {
    await expect(invoke('sync.commit', { message: 'Manual commit' })).resolves.toEqual({
      ok: true,
      value: SHARED_STATUS,
    });
    expect(sync?.commit).toHaveBeenCalledWith('Manual commit');

    await invoke('sync.commit', {});
    expect(sync?.commit).toHaveBeenCalledWith(undefined);
  });

  it('conflicts wraps the array in an object', async () => {
    await expect(invoke('sync.conflicts')).resolves.toEqual({
      ok: true,
      value: { conflicts: [{ path: 'projects/calc/requests/r1.request.yaml' }] },
    });
  });

  it('resolve forwards path and side', async () => {
    await invoke('sync.resolve', { path: 'projects/calc/requests/r1.request.yaml', side: 'theirs' });
    expect(sync?.resolve).toHaveBeenCalledWith('projects/calc/requests/r1.request.yaml', 'theirs');
  });

  it('abortMerge routes to the sync service', async () => {
    await expect(invoke('sync.abortMerge')).resolves.toEqual({ ok: true, value: SHARED_STATUS });
    expect(sync?.abortMerge).toHaveBeenCalled();
  });

  it('log wraps the entries in an object', async () => {
    await expect(invoke('sync.log', { limit: 10 })).resolves.toEqual({
      ok: true,
      value: { entries: [{ id: 'c1', subject: 'Save', author: 'a', at: '2026-09-13T00:00:00.000Z' }] },
    });
    expect(sync?.log).toHaveBeenCalledWith(10);
  });

  it('log rejects a limit that is negative, fractional, zero or over the 200 cap', async () => {
    for (const limit of [-1, 0, 1.5, 201]) {
      const result = await invoke('sync.log', { limit });
      expect(result, `limit ${String(limit)}`).toMatchObject({ ok: false, error: { code: 'ipc-invalid-request' } });
    }
    expect(sync?.log).not.toHaveBeenCalled();
  });

  it('updateSettings rejects a negative, fractional or oversized autoFetchSeconds', async () => {
    for (const autoFetchSeconds of [-1, 0.5, 86_401]) {
      const result = await invoke('sync.updateSettings', { autoFetchSeconds });
      expect(result, `autoFetchSeconds ${String(autoFetchSeconds)}`).toMatchObject({
        ok: false,
        error: { code: 'ipc-invalid-request' },
      });
    }
    expect(service.updateSyncSettings).not.toHaveBeenCalled();
  });

  it('updateSettings routes the whole patch to the service (validation lives there)', async () => {
    await expect(
      invoke('sync.updateSettings', { branch: 'main', remote: 'https://example.test/repo.git' }),
    ).resolves.toEqual({
      ok: true,
      value: SHARED_STATUS,
    });
    expect(service.updateSyncSettings).toHaveBeenCalledWith({
      branch: 'main',
      remote: 'https://example.test/repo.git',
    });
  });

  it('updateSettings surfaces a refused branch/remote as the service error code', async () => {
    service.updateSyncSettings.mockRejectedValueOnce(new WirebenchError('git-branch-refused', 'Bad branch name.'));
    await expect(invoke('sync.updateSettings', { branch: '-oops' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'git-branch-refused' },
    });

    service.updateSyncSettings.mockRejectedValueOnce(new WirebenchError('git-remote-refused', 'Bad remote.'));
    await expect(invoke('sync.updateSettings', { remote: 'not-a-url' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'git-remote-refused' },
    });
  });

  it('setIdentity forwards name and email and answers with nothing', async () => {
    await expect(invoke('sync.setIdentity', { name: 'Ada', email: 'ada@example.test' })).resolves.toEqual({
      ok: true,
      value: {},
    });
    expect(sync?.setIdentity).toHaveBeenCalledWith('Ada', 'ada@example.test');
  });

  it('setIdentity rejects an empty (or whitespace-only) name or email', async () => {
    await expect(invoke('sync.setIdentity', { name: '  ', email: 'ada@example.test' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'ipc-invalid-request' },
    });
    await expect(invoke('sync.setIdentity', { name: 'Ada', email: '' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'ipc-invalid-request' },
    });
    expect(sync?.setIdentity).not.toHaveBeenCalled();
  });

  it('revealTree joins a tree-relative path onto the tree root before revealing it', async () => {
    await expect(invoke('sync.revealTree', { path: 'projects/calc' })).resolves.toEqual({ ok: true, value: {} });
    expect(reveal).toHaveBeenCalledWith(join(TREE, 'projects/calc'));
  });

  it('revealTree with no path reveals the tree root', async () => {
    await invoke('sync.revealTree', {});
    expect(reveal).toHaveBeenCalledWith(TREE);
  });

  it('revealTree refuses a path that escapes the tree', async () => {
    const result = await invoke('sync.revealTree', { path: '../../etc/passwd' });
    expect(result.ok).toBe(false);
    expect(reveal).not.toHaveBeenCalled();
  });

  it('every channel but status throws sync-not-supported for a local (unshared) workspace', async () => {
    sync = undefined;
    service.updateSyncSettings.mockRejectedValueOnce(new WirebenchError('sync-not-supported', 'Not shared.'));

    await expect(invoke('sync.status')).resolves.toEqual({ ok: true, value: SHARED_STATUS });

    for (const [payload, channel] of [
      [undefined, 'sync.fetch'],
      [undefined, 'sync.pull'],
      [undefined, 'sync.push'],
      [{ message: undefined }, 'sync.commit'],
      [undefined, 'sync.conflicts'],
      [{ path: 'p', side: 'mine' }, 'sync.resolve'],
      [undefined, 'sync.abortMerge'],
      [{ limit: 5 }, 'sync.log'],
      [{ name: 'a', email: 'b@c.test' }, 'sync.setIdentity'],
    ] as const) {
      await expect(invoke(channel, payload)).resolves.toMatchObject({
        ok: false,
        error: { code: 'sync-not-supported' },
      });
    }
    await expect(invoke('sync.updateSettings', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'sync-not-supported' },
    });
  });

  it('status for a local workspace answers with a synthetic clean status', async () => {
    service.syncStatus.mockReturnValue(LOCAL_STATUS);
    await expect(invoke('sync.status')).resolves.toEqual({ ok: true, value: LOCAL_STATUS });
  });
});
