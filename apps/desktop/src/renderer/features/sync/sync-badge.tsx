import { Folder, GitBranch, Server } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { SyncStatusWire } from '../../../shared/wire-types.js';
import { useSyncStore } from '../../state/sync.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { formatRelative } from './relative-time.js';
import { syncCodeInfo } from './sync-codes.js';
import { useNow } from './use-now.js';

/** How often the badge's relative "3 min ago" is refreshed while it is on screen. */
const RELATIVE_TIME_REFRESH_MS = 30_000;

/** The kind glyph, shared with the Sync panel's header. `local` never renders (badge is hidden). */
const KIND_ICON: Readonly<Record<SyncStatusWire['kind'], LucideIcon>> = {
  local: GitBranch,
  git: GitBranch,
  folder: Folder,
  server: Server,
};

/**
 * The states in which a viewer's badge reads *Viewer* (server-sync §3.4): nothing more pressing (a
 * conflict, a failure, a sync in flight, no network) to report instead.
 */
const VIEWER_STATES: ReadonlySet<SyncStatusWire['state']> = new Set(['clean', 'ahead', 'behind', 'diverged']);

/**
 * The status word for a sync status — shared by the badge, the Sync panel's header and Task 15's
 * e2e helpers, so there is exactly one place the design's label table is spelled out. A server share
 * adds *Viewer* for a viewer, and the stop-polling states' own words (*Sign in*, *Account disabled*,
 * *No access*) in place of *Error*.
 */
export function syncBadgeLabel(status: SyncStatusWire): string {
  if (status.kind === 'folder') {
    return 'Synced folder';
  }
  if (status.kind === 'git' && !status.gitAvailable) {
    return 'No git';
  }
  const stopped = status.state === 'error' ? syncCodeInfo(status.error?.code)?.badge : undefined;
  if (stopped !== undefined) {
    return stopped;
  }
  if (status.role === 'viewer' && VIEWER_STATES.has(status.state)) {
    // A viewer's commits stay on this machine, so "N to push" would promise a push that cannot
    // happen; what waits to pull still can.
    return status.behind > 0 ? `Viewer · ${String(status.behind)} to pull` : 'Viewer';
  }
  switch (status.state) {
    case 'clean':
      return 'Up to date';
    case 'ahead':
      return `${String(status.ahead)} to push`;
    case 'behind':
      return `${String(status.behind)} to pull`;
    case 'diverged':
      return 'Diverged';
    case 'conflict':
      return 'Conflicts';
    case 'syncing':
      return 'Syncing…';
    case 'offline':
      return 'Offline';
    case 'error':
      return 'Error';
  }
}

/**
 * The status bar's sync indicator: a kind glyph, the status word, and — once the backend has
 * synced at least once — how long ago. Renders nothing when the open workspace is not shared.
 * Clicking it opens the Sync panel.
 */
export function SyncBadge() {
  const share = useWorkspaceStore((state) => state.workspace?.share);
  const status = useSyncStore((store) => store.status);
  const setSyncPanelOpen = useUiStore((state) => state.setSyncPanelOpen);
  // Called unconditionally (the Rules of Hooks) even though the badge below renders nothing for
  // an unshared workspace — the ticking clock only matters while it is on screen either way.
  const now = useNow(RELATIVE_TIME_REFRESH_MS);

  if (share === undefined) {
    return null;
  }

  const Icon = KIND_ICON[status.kind];
  const label = syncBadgeLabel(status);
  const relative = status.lastSyncAt === undefined ? undefined : formatRelative(status.lastSyncAt, now);
  const text = relative === undefined ? label : `${label} · ${relative}`;

  return (
    <button
      type="button"
      data-testid="status-bar-sync"
      data-state={status.state}
      title="Show the Sync panel"
      aria-label={`Sync: ${text}. Show the Sync panel`}
      className="flex items-center gap-1 rounded-sm px-1 hover:bg-surface-hover hover:text-fg-default"
      onClick={() => {
        setSyncPanelOpen(true);
      }}
    >
      <Icon size={12} aria-hidden="true" />
      {text}
    </button>
  );
}
