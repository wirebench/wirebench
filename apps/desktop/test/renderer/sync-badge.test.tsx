import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SyncBadge, syncBadgeLabel } from '../../src/renderer/features/sync/sync-badge.js';
import { useSyncStore } from '../../src/renderer/state/sync.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { workspaceWire } from '../helpers/workspace-wire.js';
import type { SyncStatusWire } from '../../src/shared/wire-types.js';

const BASE: SyncStatusWire = { kind: 'git', gitAvailable: true, state: 'clean', ahead: 0, behind: 0, uncommitted: 0 };

describe('syncBadgeLabel', () => {
  it('labels every state', () => {
    expect(syncBadgeLabel({ ...BASE, state: 'clean' })).toBe('Up to date');
    expect(syncBadgeLabel({ ...BASE, state: 'ahead', ahead: 3 })).toBe('3 to push');
    expect(syncBadgeLabel({ ...BASE, state: 'behind', behind: 2 })).toBe('2 to pull');
    expect(syncBadgeLabel({ ...BASE, state: 'diverged' })).toBe('Diverged');
    expect(syncBadgeLabel({ ...BASE, state: 'conflict' })).toBe('Conflicts');
    expect(syncBadgeLabel({ ...BASE, state: 'syncing' })).toBe('Syncing…');
    expect(syncBadgeLabel({ ...BASE, state: 'offline' })).toBe('Offline');
    expect(syncBadgeLabel({ ...BASE, state: 'error' })).toBe('Error');
  });

  it('says "No git" when git is unavailable for a git share, regardless of state', () => {
    expect(syncBadgeLabel({ ...BASE, gitAvailable: false, state: 'clean' })).toBe('No git');
  });

  it('always says "Synced folder" for a folder share', () => {
    expect(syncBadgeLabel({ ...BASE, kind: 'folder', state: 'ahead', ahead: 1 })).toBe('Synced folder');
  });
});

describe('SyncBadge', () => {
  beforeEach(() => {
    useUiStore.setState({ syncPanelOpen: false });
  });
  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspace: null });
    useSyncStore.getState().reset();
    useUiStore.setState({ syncPanelOpen: false });
  });

  it('renders nothing when the open workspace is not shared', () => {
    useWorkspaceStore.setState({ workspace: workspaceWire() });
    render(<SyncBadge />);
    expect(screen.queryByTestId('status-bar-sync')).toBeNull();
  });

  it('shows the state as data-state and the label as text, with an aria-label', () => {
    useWorkspaceStore.setState({ workspace: workspaceWire({ share: { kind: 'git', managed: true } }) });
    useSyncStore.setState({ status: { ...BASE, state: 'ahead', ahead: 4 } });
    render(<SyncBadge />);

    const badge = screen.getByTestId('status-bar-sync');
    expect(badge.getAttribute('data-state')).toBe('ahead');
    expect(badge.textContent).toContain('4 to push');
    expect(badge.getAttribute('aria-label')).toContain('4 to push');
  });

  it('advances the relative last-sync time as the clock ticks, and clears its timer on unmount', () => {
    vi.useFakeTimers();
    try {
      const start = new Date('2026-09-14T12:00:00Z');
      vi.setSystemTime(start);
      useWorkspaceStore.setState({ workspace: workspaceWire({ share: { kind: 'git', managed: true } }) });
      useSyncStore.setState({ status: { ...BASE, lastSyncAt: start.toISOString() } });
      const baseline = vi.getTimerCount();
      const { unmount } = render(<SyncBadge />);

      expect(screen.getByTestId('status-bar-sync').textContent).toContain('just now');

      act(() => {
        vi.advanceTimersByTime(60_000);
      });

      expect(screen.getByTestId('status-bar-sync').textContent).toContain('1 min ago');

      unmount();
      expect(vi.getTimerCount()).toBe(baseline);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the Sync panel when clicked', async () => {
    useWorkspaceStore.setState({ workspace: workspaceWire({ share: { kind: 'git', managed: true } }) });
    useSyncStore.setState({ status: BASE });
    render(<SyncBadge />);

    await userEvent.click(screen.getByTestId('status-bar-sync'));
    expect(useUiStore.getState().syncPanelOpen).toBe(true);
  });
});
