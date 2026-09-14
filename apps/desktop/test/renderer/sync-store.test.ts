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

  it('abortMerge() clears the conflicts once the merge is cancelled', async () => {
    openWorkspace('w1');
    useSyncStore.setState({ status: { ...GIT_STATUS, state: 'conflict' }, conflicts: [{ path: 'x' }] });
    const abortMerge = vi.fn().mockResolvedValue({ ok: true, value: { ...GIT_STATUS, state: 'syncing' } });
    installWirebenchApi({ sync: { abortMerge } });

    await useSyncStore.getState().abortMerge();
    expect(useSyncStore.getState().conflicts).toEqual([]);
  });

  it.each(['offline', 'error', 'syncing', 'conflict'] as const)(
    'an applied %s status keeps the conflicts of a merge that may still be open',
    (state) => {
      openWorkspace('w1');
      useSyncStore.setState({ status: { ...GIT_STATUS, state: 'conflict' }, conflicts: [{ path: 'x' }] });
      useSyncStore.getState().applyStatus('w1', { ...GIT_STATUS, state });
      expect(useSyncStore.getState().conflicts).toEqual([{ path: 'x' }]);
    },
  );

  it.each(['clean', 'ahead', 'behind', 'diverged'] as const)(
    'an applied %s status proves no merge is open and clears the conflicts',
    (state) => {
      openWorkspace('w1');
      useSyncStore.setState({ status: { ...GIT_STATUS, state: 'conflict' }, conflicts: [{ path: 'x' }] });
      // An abort from outside the app (the terminal) shows up only as a status change.
      useSyncStore.getState().applyStatus('w1', { ...GIT_STATUS, state });
      expect(useSyncStore.getState().conflicts).toEqual([]);
    },
  );

  it('loads the conflicts when a conflict status arrives while the list is empty, and not when it is already filled', async () => {
    openWorkspace('w1');
    const conflicts = vi.fn().mockResolvedValue({ ok: true, value: { conflicts: [{ path: 'projects/calc/x.yaml' }] } });
    installWirebenchApi({ sync: { conflicts } });

    useSyncStore.getState().applyStatus('w1', { ...GIT_STATUS, state: 'conflict' });
    await vi.waitFor(() => expect(useSyncStore.getState().conflicts).toEqual([{ path: 'projects/calc/x.yaml' }]));
    expect(conflicts).toHaveBeenCalledTimes(1);

    useSyncStore.getState().applyStatus('w1', { ...GIT_STATUS, state: 'conflict' });
    await Promise.resolve();
    expect(conflicts).toHaveBeenCalledTimes(1);
  });

  it('refresh() loads the conflicts when the status it reads is conflict', async () => {
    openWorkspace('w1');
    const status = vi.fn().mockResolvedValue({ ok: true, value: { ...GIT_STATUS, state: 'conflict' } });
    const conflicts = vi.fn().mockResolvedValue({ ok: true, value: { conflicts: [{ path: 'projects/calc/x.yaml' }] } });
    installWirebenchApi({ sync: { status, conflicts } });

    await useSyncStore.getState().refresh();
    expect(conflicts).toHaveBeenCalledTimes(1);
    expect(useSyncStore.getState().conflicts).toEqual([{ path: 'projects/calc/x.yaml' }]);
  });

  it('toasts a git-config-refused status once, with its message', () => {
    openWorkspace('w1');
    const refused = {
      ...GIT_STATUS,
      state: 'error' as const,
      error: { code: 'git-config-refused', message: "This repository's .git/config sets core.fsmonitor…" },
    };

    useSyncStore.getState().applyStatus('w1', refused);
    useSyncStore.getState().applyStatus('w1', refused);

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith("This repository's .git/config sets core.fsmonitor…");
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

  it('workspace.changedOnDisk toasts the T4 load-failure message for the open workspace', () => {
    openWorkspace('w1');
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

  it('ignores workspace.changedOnDisk for a workspace that is not open', () => {
    openWorkspace('w1');
    const listeners = new Map<string, (payload: unknown) => void>();
    installWirebenchApi({
      on: vi.fn().mockImplementation((name: string, listener: (payload: unknown) => void) => {
        listeners.set(name, listener);
        return vi.fn();
      }),
    });

    const unsubscribe = subscribeToSync();
    listeners.get('workspace.changedOnDisk')?.({
      workspaceId: 'other',
      paths: ['workspace.yaml'],
      message: 'bad indentation',
    });

    expect(showToast).not.toHaveBeenCalled();
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

  it('subscribeToSync keeps conflicts and identityNeeded across a workspace.changed for the same workspace', () => {
    useSyncStore.setState({ status: GIT_STATUS, conflicts: [{ path: 'x' }], identityNeeded: true });
    const listeners = new Map<string, (payload: unknown) => void>();
    installWirebenchApi({
      sync: { status: vi.fn().mockResolvedValue({ ok: true, value: GIT_STATUS }) },
      on: vi.fn().mockImplementation((name: string, listener: (payload: unknown) => void) => {
        listeners.set(name, listener);
        return vi.fn();
      }),
    });

    const unsubscribe = subscribeToSync();
    const workspace: WorkspaceWire = {
      id: 'w1',
      name: 'W (renamed)',
      dir: '/user-data/workspaces/w1',
      properties: {},
      disabled: [],
      environments: [],
      projects: [],
      share: { kind: 'git', managed: true },
    };
    // First event establishes the baseline (this workspace, shared) — a real mount would have
    // gotten here via `workspace.snapshot`/an earlier event; the second is the same workspace
    // changing again (e.g. an environment edit), which must not touch the conflict list.
    listeners.get('workspace.changed')?.({ workspace });
    useSyncStore.setState({ conflicts: [{ path: 'x' }], identityNeeded: true });
    listeners.get('workspace.changed')?.({ workspace: { ...workspace, name: 'W (renamed again)' } });

    expect(useSyncStore.getState()).toMatchObject({ conflicts: [{ path: 'x' }], identityNeeded: true });
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

  it('loads the real status on mount for a shared workspace already open, with no event fired', async () => {
    // A renderer reload (or a window reopened from the dock) with a shared workspace already
    // open in main: there is no `workspace.changed` for this mount to react to — the initial
    // `sync.status` pull in `subscribeToSync` itself is what must load the real status.
    openWorkspace('w1');
    const diverged = {
      kind: 'git' as const,
      gitAvailable: true,
      state: 'diverged' as const,
      ahead: 1,
      behind: 2,
      uncommitted: 0,
      remote: 'https://example.test/repo.git',
      branch: 'main',
    };
    const status = vi.fn().mockResolvedValue({ ok: true, value: diverged });
    installWirebenchApi({
      sync: { status },
      on: vi.fn().mockReturnValue(() => undefined),
    });

    const unsubscribe = subscribeToSync();
    await Promise.resolve();
    await Promise.resolve();

    expect(status).toHaveBeenCalledWith(undefined);
    expect(useSyncStore.getState().status).toEqual(diverged);
    unsubscribe();
  });
});
