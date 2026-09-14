import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SyncBanner } from '../../src/renderer/features/sync/sync-banner.js';
import { useSyncStore } from '../../src/renderer/state/sync.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { workspaceWire } from '../helpers/workspace-wire.js';
import type { SyncConflictWire } from '../../src/shared/wire-types.js';

/** Captures every `window.wirebench.on` listener by channel, like `sync-store.test.ts` does. */
function stubApiWithListeners(): Map<string, (payload: unknown) => void> {
  const listeners = new Map<string, (payload: unknown) => void>();
  installWirebenchApi({
    on: vi.fn().mockImplementation((name: string, listener: (payload: unknown) => void) => {
      listeners.set(name, listener);
      return vi.fn();
    }),
  });
  return listeners;
}

describe('SyncBanner', () => {
  beforeEach(() => {
    useSyncStore.getState().reset();
    useUiStore.setState({ conflictResolverOpen: false });
    useWorkspaceStore.setState({ workspace: workspaceWire({ id: 'w1' }) });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders nothing with no pulled notice and no conflicts', () => {
    const listeners = stubApiWithListeners();
    const { container } = render(<SyncBanner />);
    void listeners;
    expect(container.firstChild).toBeNull();
  });

  it('shows a pulled notice naming the remote host, and auto-dismisses after 8s', () => {
    vi.useFakeTimers();
    useSyncStore.setState({
      status: {
        kind: 'git',
        gitAvailable: true,
        state: 'clean',
        ahead: 0,
        behind: 0,
        uncommitted: 0,
        remote: 'https://github.com/acme/demo.git',
      },
    });
    const listeners = stubApiWithListeners();
    render(<SyncBanner />);

    act(() => {
      listeners.get('sync.pulled')?.({
        workspaceId: 'w1',
        projectIds: ['p1'],
        workspaceChanged: false,
        entityCount: 3,
      });
    });

    expect(screen.getByTestId('sync-banner-pulled').textContent).toContain('Pulled 3 changes from github.com');

    act(() => {
      vi.advanceTimersByTime(7999);
    });
    expect(screen.queryByTestId('sync-banner-pulled')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByTestId('sync-banner-pulled')).toBeNull();
  });

  it('shows the notice without a host when the remote cannot be parsed', () => {
    useSyncStore.setState({
      status: { kind: 'folder', gitAvailable: true, state: 'clean', ahead: 0, behind: 0, uncommitted: 0 },
    });
    const listeners = stubApiWithListeners();
    render(<SyncBanner />);

    act(() => {
      listeners.get('sync.pulled')?.({ workspaceId: 'w1', projectIds: [], workspaceChanged: false, entityCount: 1 });
    });

    expect(screen.getByTestId('sync-banner-pulled').textContent).toContain('Pulled 1 change.');
    expect(screen.getByTestId('sync-banner-pulled').textContent).not.toContain('from');
  });

  it('ignores a pulled event for a workspace that is not open', () => {
    const listeners = stubApiWithListeners();
    render(<SyncBanner />);

    act(() => {
      listeners.get('sync.pulled')?.({ workspaceId: 'other', projectIds: [], workspaceChanged: false, entityCount: 5 });
    });

    expect(screen.queryByTestId('sync-banner-pulled')).toBeNull();
  });

  it('can be dismissed manually before the timer runs out', async () => {
    const user = userEvent.setup();
    const listeners = stubApiWithListeners();
    render(<SyncBanner />);

    act(() => {
      listeners.get('sync.pulled')?.({ workspaceId: 'w1', projectIds: [], workspaceChanged: false, entityCount: 2 });
    });
    expect(screen.getByTestId('sync-banner-pulled')).toBeTruthy();

    await user.click(screen.getByTestId('sync-banner-pulled-dismiss'));
    expect(screen.queryByTestId('sync-banner-pulled')).toBeNull();
  });

  it('shows a conflict call to action that opens the conflict resolver', async () => {
    const user = userEvent.setup();
    const conflicts: SyncConflictWire[] = [
      { path: 'x', projectId: 'p1' },
      { path: 'y', projectId: 'p1' },
    ];
    useSyncStore.setState({ conflicts });
    const listeners = stubApiWithListeners();
    render(<SyncBanner />);
    void listeners;

    const banner = screen.getByTestId('sync-banner-conflicts');
    expect(banner.textContent).toContain('2');

    await user.click(screen.getByTestId('sync-banner-resolve'));
    expect(useUiStore.getState().conflictResolverOpen).toBe(true);
  });
});
