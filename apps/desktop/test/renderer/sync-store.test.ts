import { beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeToSync, useSyncStore } from '../../src/renderer/state/sync.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { WorkspaceWire } from '../../src/shared/wire-types.js';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast }));

const LOCAL_STATUS = {
  kind: 'local' as const,
  gitAvailable: true,
  state: 'clean' as const,
  ahead: 0,
  behind: 0,
  uncommitted: 0,
};
const GIT_STATUS = {
  kind: 'git' as const,
  gitAvailable: true,
  state: 'ahead' as const,
  ahead: 2,
  behind: 0,
  uncommitted: 0,
  remote: 'https://example.test/repo.git',
  branch: 'main',
};

function openWorkspace(id: string, shared = true): void {
  const workspace: WorkspaceWire = {
    id,
    name: 'W',
    dir: `/user-data/workspaces/${id}`,
    properties: {},
    disabled: [],
    environments: [],
    projects: [],
    ...(shared ? { share: { kind: 'git' as const, managed: true } } : {}),
  };
  useWorkspaceStore.setState({ workspace });
}

describe('useSyncStore', () => {
  beforeEach(() => {
    showToast.mockClear();
    useSyncStore.getState().reset();
    useWorkspaceStore.setState({ workspace: null });
  });

  it('applyStatus applies a status for the open workspace and ignores one for another', () => {
    openWorkspace('w1');
    useSyncStore.getState().applyStatus('w1', GIT_STATUS);
    expect(useSyncStore.getState().status).toEqual(GIT_STATUS);

    useSyncStore.getState().applyStatus('w2', LOCAL_STATUS);
    expect(useSyncStore.getState().status).toEqual(GIT_STATUS);
  });

  it('reset() goes back to the synthetic local status with no conflicts', () => {
    useSyncStore.setState({ status: GIT_STATUS, conflicts: [{ path: 'x' }], identityNeeded: true });
    useSyncStore.getState().reset();
    expect(useSyncStore.getState()).toMatchObject({ status: LOCAL_STATUS, conflicts: [], identityNeeded: false });
  });

  it('pull() calls the channel and stores the returned status', async () => {
    openWorkspace('w1');
    const pull = vi.fn().mockResolvedValue({ ok: true, value: GIT_STATUS });
    installWirebenchApi({ sync: { pull } });

    await useSyncStore.getState().pull();

    expect(pull).toHaveBeenCalledWith(undefined);
    expect(useSyncStore.getState().status).toEqual(GIT_STATUS);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a failing channel toasts the error message', async () => {
    installWirebenchApi({
      sync: { pull: vi.fn().mockResolvedValue({ ok: false, error: { code: 'git-offline', message: 'No network.' } }) },
    });

    await useSyncStore.getState().pull();

    expect(showToast).toHaveBeenCalledWith('No network.');
  });

  it('treats sync-no-remote and sync-stopped as expected, without a toast', async () => {
    installWirebenchApi({
      sync: {
        push: vi
          .fn()
          .mockResolvedValue({ ok: false, error: { code: 'sync-no-remote', message: 'Nothing to push to.' } }),
      },
    });
    await useSyncStore.getState().push();
    expect(showToast).not.toHaveBeenCalled();

    installWirebenchApi({
      sync: {
        commit: vi.fn().mockResolvedValue({ ok: false, error: { code: 'sync-stopped', message: 'Sync stopped.' } }),
      },
    });
    await useSyncStore.getState().commit();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('workspace.changedOnDisk toasts the T4 load-failure message', () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    installWirebenchApi({
      on: vi.fn().mockImplementation((name: string, listener: (payload: unknown) => void) => {
        listeners.set(name, listener);
        return vi.fn();
      }),
    });

    const unsubscribe = subscribeToSync();
    listeners.get('workspace.changedOnDisk')?.({
      workspaceId: 'w1',
      paths: ['workspace.yaml'],
      message: 'bad indentation',
    });

    expect(showToast).toHaveBeenCalledWith('Workspace files changed on disk but could not be read: bad indentation');
    unsubscribe();
  });

  it('subscribeToSync applies sync.statusChanged for the open workspace', () => {
    openWorkspace('w1');
    const listeners = new Map<string, (payload: unknown) => void>();
    installWirebenchApi({
      on: vi.fn().mockImplementation((name: string, listener: (payload: unknown) => void) => {
        listeners.set(name, listener);
        return vi.fn();
      }),
    });

    const unsubscribe = subscribeToSync();
    listeners.get('sync.statusChanged')?.({ workspaceId: 'w1', status: GIT_STATUS });
    expect(useSyncStore.getState().status).toEqual(GIT_STATUS);

    listeners.get('sync.statusChanged')?.({ workspaceId: 'other', status: LOCAL_STATUS });
    expect(useSyncStore.getState().status).toEqual(GIT_STATUS);

    unsubscribe();
  });

  it('subscribeToSync resets on workspace.changed', () => {
    useSyncStore.setState({ status: GIT_STATUS, conflicts: [{ path: 'x' }], identityNeeded: true });
    const listeners = new Map<string, (payload: unknown) => void>();
    const status = vi.fn().mockResolvedValue({ ok: true, value: LOCAL_STATUS });
    installWirebenchApi({
      sync: { status },
      on: vi.fn().mockImplementation((name: string, listener: (payload: unknown) => void) => {
        listeners.set(name, listener);
        return vi.fn();
      }),
    });

    const unsubscribe = subscribeToSync();
    listeners.get('workspace.changed')?.({ workspace: null });

    expect(useSyncStore.getState()).toMatchObject({ status: LOCAL_STATUS, conflicts: [], identityNeeded: false });
    unsubscribe();
  });

  it('subscribeToSync re-fetches status for a shared workspace after a reset', async () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const status = vi.fn().mockResolvedValue({ ok: true, value: GIT_STATUS });
    installWirebenchApi({
      sync: { status },
      on: vi.fn().mockImplementation((name: string, listener: (payload: unknown) => void) => {
        listeners.set(name, listener);
        return vi.fn();
      }),
    });

    const unsubscribe = subscribeToSync();
    const workspace: WorkspaceWire = {
      id: 'w1',
      name: 'W',
      dir: '/user-data/workspaces/w1',
      properties: {},
      disabled: [],
      environments: [],
      projects: [],
      share: { kind: 'git', managed: true },
    };
    listeners.get('workspace.changed')?.({ workspace });
    await Promise.resolve();
    await Promise.resolve();

    expect(status).toHaveBeenCalled();
    unsubscribe();
  });
});
