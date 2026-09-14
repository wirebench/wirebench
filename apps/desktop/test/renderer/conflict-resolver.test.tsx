import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConflictResolver } from '../../src/renderer/features/sync/conflict-resolver.js';
import { useSyncStore } from '../../src/renderer/state/sync.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { SyncConflictWire, SyncStatusWire } from '../../src/shared/wire-types.js';

const LOCAL_STATUS: SyncStatusWire = {
  kind: 'git',
  gitAvailable: true,
  state: 'conflict',
  ahead: 0,
  behind: 0,
  uncommitted: 0,
};

const CONFLICTS: readonly SyncConflictWire[] = [
  {
    path: 'projects/Demo/interfaces/Calc/operations/Add/Request 1.request.yaml',
    projectId: 'p1',
    entity: { kind: 'request', name: 'Request 1' },
  },
  { path: 'projects/Demo/wirebench.yaml', projectId: 'p1', entity: { kind: 'project', name: 'Demo' } },
];

describe('ConflictResolver', () => {
  beforeEach(() => {
    useSyncStore.getState().reset();
    useUiStore.setState({ conflictResolverOpen: false });
  });

  afterEach(() => {
    cleanup();
  });

  it('is closed when conflictResolverOpen is false', () => {
    installWirebenchApi({
      sync: { conflicts: vi.fn().mockResolvedValue({ ok: true, value: { conflicts: CONFLICTS } }) },
    });
    render(<ConflictResolver />);
    expect(screen.queryByTestId('conflict-resolver')).toBeNull();
  });

  it('lists every unresolved conflict once opened, and offers Keep mine/Keep theirs/Open file per row', async () => {
    installWirebenchApi({
      sync: { conflicts: vi.fn().mockResolvedValue({ ok: true, value: { conflicts: CONFLICTS } }) },
    });
    useSyncStore.setState({ conflicts: CONFLICTS, status: LOCAL_STATUS });
    useUiStore.setState({ conflictResolverOpen: true });

    render(<ConflictResolver />);

    await waitFor(() => {
      expect(screen.getAllByTestId('conflict-resolver-row')).toHaveLength(2);
    });
    const rows = screen.getAllByTestId('conflict-resolver-row');
    const row = within(rows[0] as HTMLElement);
    expect(row.getByTestId('conflict-resolver-mine').textContent).toBe('Keep mine');
    expect(row.getByTestId('conflict-resolver-theirs').textContent).toBe('Keep theirs');
    expect(row.getByTestId('conflict-resolver-open').textContent).toBe('Open file');
  });

  it('Open file reveals the tree-relative path of that row', async () => {
    const revealTree = vi.fn().mockResolvedValue({ ok: true, value: {} });
    installWirebenchApi({
      sync: {
        conflicts: vi.fn().mockResolvedValue({ ok: true, value: { conflicts: CONFLICTS } }),
        revealTree,
      },
    });
    useSyncStore.setState({ conflicts: CONFLICTS, status: LOCAL_STATUS });
    useUiStore.setState({ conflictResolverOpen: true });

    render(<ConflictResolver />);
    await waitFor(() => {
      expect(screen.getAllByTestId('conflict-resolver-row')).toHaveLength(2);
    });

    const rows = screen.getAllByTestId('conflict-resolver-row');
    await userEvent.click(within(rows[0] as HTMLElement).getByTestId('conflict-resolver-open'));

    expect(revealTree).toHaveBeenCalledWith({
      path: 'projects/Demo/interfaces/Calc/operations/Add/Request 1.request.yaml',
    });
  });

  it('Keep mine resolves the row, reloads the remaining conflicts, and closes itself once empty', async () => {
    const resolve = vi.fn().mockResolvedValue({ ok: true, value: LOCAL_STATUS });
    const conflicts = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { conflicts: CONFLICTS } })
      .mockResolvedValueOnce({ ok: true, value: { conflicts: [] } });
    installWirebenchApi({ sync: { conflicts, resolve } });
    useSyncStore.setState({ conflicts: CONFLICTS, status: LOCAL_STATUS });
    useUiStore.setState({ conflictResolverOpen: true });

    render(<ConflictResolver />);
    await waitFor(() => {
      expect(screen.getAllByTestId('conflict-resolver-row')).toHaveLength(2);
    });

    const rows = screen.getAllByTestId('conflict-resolver-row');
    await userEvent.click(within(rows[0] as HTMLElement).getByTestId('conflict-resolver-mine'));

    expect(resolve).toHaveBeenCalledWith({
      path: 'projects/Demo/interfaces/Calc/operations/Add/Request 1.request.yaml',
      side: 'mine',
    });
    await waitFor(() => {
      expect(useUiStore.getState().conflictResolverOpen).toBe(false);
    });
  });

  it('stays open through a cold start (empty store, a slower loadConflicts resolving non-empty), then closes once the last row resolves', async () => {
    // A single conflict this time, so "Keep mine" resolving it is the dialog's very last row.
    const oneConflict = [CONFLICTS[0] as SyncConflictWire];
    let releaseFirstLoad: (() => void) | undefined;
    const firstLoad = new Promise<void>((resolve) => {
      releaseFirstLoad = resolve;
    });
    const conflicts = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstLoad;
        return { ok: true, value: { conflicts: oneConflict } };
      })
      .mockResolvedValueOnce({ ok: true, value: { conflicts: [] } });
    const resolve = vi.fn().mockResolvedValue({ ok: true, value: LOCAL_STATUS });
    installWirebenchApi({ sync: { conflicts, resolve } });
    // The store starts empty, as it would on a cold app start opened directly into `conflict`
    // state (e.g. via the `sync.resolveConflicts` command) before the resolver's own load lands.
    useSyncStore.setState({ conflicts: [], status: LOCAL_STATUS });
    useUiStore.setState({ conflictResolverOpen: true });

    render(<ConflictResolver />);

    // The load has not settled yet — the resolver must not have already decided "empty, close".
    expect(screen.getByTestId('conflict-resolver')).toBeTruthy();
    expect(useUiStore.getState().conflictResolverOpen).toBe(true);

    releaseFirstLoad?.();
    await waitFor(() => {
      expect(screen.getAllByTestId('conflict-resolver-row')).toHaveLength(1);
    });
    expect(useUiStore.getState().conflictResolverOpen).toBe(true);

    const row = screen.getByTestId('conflict-resolver-row');
    await userEvent.click(within(row).getByTestId('conflict-resolver-mine'));

    await waitFor(() => {
      expect(useUiStore.getState().conflictResolverOpen).toBe(false);
    });
  });

  it('Cancel asks for confirmation, and confirming aborts the merge and closes', async () => {
    const abortMerge = vi.fn().mockResolvedValue({ ok: true, value: LOCAL_STATUS });
    installWirebenchApi({
      sync: { conflicts: vi.fn().mockResolvedValue({ ok: true, value: { conflicts: CONFLICTS } }), abortMerge },
    });
    useSyncStore.setState({ conflicts: CONFLICTS, status: LOCAL_STATUS });
    useUiStore.setState({ conflictResolverOpen: true });

    render(<ConflictResolver />);
    await waitFor(() => {
      expect(screen.getAllByTestId('conflict-resolver-row')).toHaveLength(2);
    });

    await userEvent.click(screen.getByTestId('conflict-resolver-cancel'));
    expect(await screen.findByText('Cancel the merge?')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel merge' }));

    await waitFor(() => {
      expect(abortMerge).toHaveBeenCalled();
    });
    expect(useUiStore.getState().conflictResolverOpen).toBe(false);
  });
});
