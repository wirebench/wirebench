import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SyncBadge, syncBadgeLabel } from '../../src/renderer/features/sync/sync-badge.js';
import { useSyncStore } from '../../src/renderer/state/sync.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { workspaceWire } from '../helpers/workspace-wire.js';
import type { SyncStatusWire, WorkspaceShareWire } from '../../src/shared/wire-types.js';

const BASE: SyncStatusWire = { kind: 'git', gitAvailable: true, state: 'clean', ahead: 0, behind: 0, uncommitted: 0 };

const SERVER_SHARE: WorkspaceShareWire = {
  kind: 'server',
  managed: true,
  server: { url: 'https://wb.example.com', workspaceId: '01J8ZK6Q3V4W5X6Y7Z8A9B0C1D', teamName: 'Payments QA' },
};

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

  it('says "Viewer" for a viewer while nothing more pressing is going on, with what waits to pull', () => {
    const viewer: SyncStatusWire = { ...BASE, kind: 'server', role: 'viewer' };
    expect(syncBadgeLabel({ ...viewer, state: 'clean' })).toBe('Viewer');
    expect(syncBadgeLabel({ ...viewer, state: 'ahead', ahead: 2 })).toBe('Viewer');
    expect(syncBadgeLabel({ ...viewer, state: 'behind', behind: 3 })).toBe('Viewer · 3 to pull');
    expect(syncBadgeLabel({ ...viewer, state: 'diverged', ahead: 1, behind: 1 })).toBe('Viewer · 1 to pull');
    expect(syncBadgeLabel({ ...viewer, state: 'conflict' })).toBe('Conflicts');
    expect(syncBadgeLabel({ ...viewer, state: 'offline' })).toBe('Offline');
    expect(syncBadgeLabel({ ...viewer, state: 'syncing' })).toBe('Syncing…');
    expect(syncBadgeLabel({ ...BASE, kind: 'server', role: 'editor', state: 'ahead', ahead: 2 })).toBe('2 to push');
  });

  it('names the stop-polling states, and keeps "Error" for any other failure', () => {
    const failed = (code: string): SyncStatusWire => ({
      ...BASE,
      kind: 'server',
      state: 'error',
      error: { code, message: code },
    });
    expect(syncBadgeLabel(failed('sync-signed-out'))).toBe('Sign in');
    expect(syncBadgeLabel(failed('sync-account-disabled'))).toBe('Account disabled');
    expect(syncBadgeLabel(failed('sync-access-removed'))).toBe('No access');
    expect(syncBadgeLabel({ ...failed('sync-signed-out'), role: 'viewer' })).toBe('Sign in');
    expect(syncBadgeLabel(failed('sync-history-mismatch'))).toBe('Error');
    expect(syncBadgeLabel({ ...BASE, state: 'error', error: { code: 'git-auth-failed', message: 'x' } })).toBe('Error');
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

  it('shows Viewer on a server share for a viewer', () => {
    useWorkspaceStore.setState({ workspace: workspaceWire({ share: SERVER_SHARE }) });
    useSyncStore.setState({ status: { ...BASE, kind: 'server', role: 'viewer', state: 'ahead', ahead: 1 } });
    render(<SyncBadge />);

    const badge = screen.getByTestId('status-bar-sync');
    expect(badge.textContent).toBe('Viewer');
    expect(badge.getAttribute('data-state')).toBe('ahead');
  });
});

describe('SyncBadge live dot (live-updates §3.4, §5.4)', () => {
  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspace: null });
    useSyncStore.getState().reset();
  });

  it.each([
    ['connected', 'Live'],
    ['connecting', 'Reconnecting…'],
  ] as const)('shows a %s dot with the tooltip "%s", and names it for a screen reader', (live, tooltip) => {
    useWorkspaceStore.setState({ workspace: workspaceWire({ share: SERVER_SHARE }) });
    useSyncStore.setState({ status: { ...BASE, kind: 'server', role: 'editor', live } });
    render(<SyncBadge />);

    const dot = screen.getByTestId('sync-live-dot');
    expect(dot.getAttribute('data-state')).toBe(live);
    expect(dot.getAttribute('title')).toBe(tooltip);
    const badge = screen.getByTestId('status-bar-sync');
    expect(badge.contains(dot)).toBe(true);
    // The dot adds no text: the label, and every e2e wait keyed on the badge, read as before.
    expect(badge.textContent).toBe('Up to date');
    expect(badge.getAttribute('data-state')).toBe('clean');
    expect(badge.getAttribute('aria-label')).toBe(`Sync: Up to date. ${tooltip}. Show the Sync panel`);
  });

  it('shows no dot while the socket is off: polling looks exactly as it did before', () => {
    useWorkspaceStore.setState({ workspace: workspaceWire({ share: SERVER_SHARE }) });
    useSyncStore.setState({ status: { ...BASE, kind: 'server', role: 'editor', live: 'off' } });
    render(<SyncBadge />);

    const badge = screen.getByTestId('status-bar-sync');
    expect(screen.queryByTestId('sync-live-dot')).toBeNull();
    expect(badge.getAttribute('aria-label')).toBe('Sync: Up to date. Show the Sync panel');
  });

  it('shows no dot when the status carries no live state, as on a git share', () => {
    useWorkspaceStore.setState({ workspace: workspaceWire({ share: { kind: 'git', managed: true } }) });
    useSyncStore.setState({ status: BASE });
    render(<SyncBadge />);

    const badge = screen.getByTestId('status-bar-sync');
    expect(screen.queryByTestId('sync-live-dot')).toBeNull();
    expect(badge.getAttribute('aria-label')).toBe('Sync: Up to date. Show the Sync panel');
  });

  it('follows the live state as new statuses arrive', () => {
    useWorkspaceStore.setState({ workspace: workspaceWire({ share: SERVER_SHARE }) });
    useSyncStore.setState({ status: { ...BASE, kind: 'server', live: 'connected' } });
    render(<SyncBadge />);
    expect(screen.getByTestId('sync-live-dot').getAttribute('data-state')).toBe('connected');

    act(() => {
      useSyncStore.setState({ status: { ...BASE, kind: 'server', live: 'connecting' } });
    });
    expect(screen.getByTestId('sync-live-dot').getAttribute('data-state')).toBe('connecting');
    expect(screen.getByTestId('sync-live-dot').getAttribute('title')).toBe('Reconnecting…');

    act(() => {
      useSyncStore.setState({ status: { ...BASE, kind: 'server', live: 'off' } });
    });
    expect(screen.queryByTestId('sync-live-dot')).toBeNull();
  });
});
