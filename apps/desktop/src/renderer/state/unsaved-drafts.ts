/**
 * The renderer's half of keeping unsaved changes across sessions: handing the request edits it
 * holds unsaved (the drafts store) to main, which keeps them with the workspace, and laying them
 * back over the mirror when that workspace opens again.
 *
 * Main keeps everything else unsaved on its own (see `main/unsaved-store.ts`); drafts are the one
 * kind of unsaved change that exists only here until the user saves. They are handed over shortly
 * after they change (so a crash costs at most that moment), right before the workspace is left,
 * and when main asks on its way to quitting (`workspace.flushDrafts`).
 *
 * Deliberately free of the workspace store — the caller passes the workspace id — so the
 * workspace store can depend on this module without an import cycle.
 */

import { showToast } from '../components/toast.js';
import type { UnsavedRestoreNoticeWire, WorkspaceRestoredResponse } from '../../shared/wire-types.js';
import { useDraftsStore } from './drafts.js';
import { ipc } from './ipc-client.js';
import { useProjectStore } from './project.js';

/** How long after a draft changes it is handed to main. */
export const DRAFTS_STASH_DEBOUNCE_MS = 1_000;

let pending: ReturnType<typeof setTimeout> | undefined;

function cancelPending(): void {
  if (pending !== undefined) {
    clearTimeout(pending);
    pending = undefined;
  }
}

/** Hands every current draft to main for `workspaceId` now, replacing what it held. */
export async function stashDrafts(workspaceId: string): Promise<void> {
  cancelPending();
  const { requests, restRequests, grpcRequests } = useDraftsStore.getState();
  await ipc().workspace.stashDrafts({
    workspaceId,
    requests: { ...requests },
    restRequests: { ...restRequests },
    grpcRequests: { ...grpcRequests },
  });
}

/**
 * Keeps main's copy of the drafts current: shortly after every change, and at once when main asks
 * (it is about to close the workspace). `workspaceId` is read at the moment of sending, so a
 * change made just before a switch is stashed for the workspace that is open when it goes out.
 */
export function subscribeToDraftStash(workspaceId: () => string | undefined): () => void {
  const send = (): void => {
    const id = workspaceId();
    if (id !== undefined) {
      void stashDrafts(id).catch(() => undefined);
    }
  };
  const offStore = useDraftsStore.subscribe((state, previous) => {
    if (
      state.requests === previous.requests &&
      state.restRequests === previous.restRequests &&
      state.grpcRequests === previous.grpcRequests
    ) {
      return;
    }
    cancelPending();
    pending = setTimeout(() => {
      pending = undefined;
      send();
    }, DRAFTS_STASH_DEBOUNCE_MS);
  });
  const offFlush = window.wirebench.on('workspace.flushDrafts', () => {
    send();
  });
  return () => {
    cancelPending();
    offStore();
    offFlush();
  };
}

/** A project-relative file path, as a reader would name it: `requests/Add.yaml` → `Add`. */
function fileLabel(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.ya?ml$/i, '');
}

/** The sentence one project's restore notice reads as. */
export function noticeMessage(notice: UnsavedRestoreNoticeWire): string {
  if (notice.status === 'failed') {
    return `Couldn't restore unsaved changes in ${notice.projectName}${notice.message !== undefined ? `: ${notice.message}` : ''}`;
  }
  const parts = [`Restored unsaved changes in ${notice.projectName}`];
  if (notice.conflicts.length > 0) {
    parts.push(`also changed on disk, kept yours: ${notice.conflicts.map(fileLabel).join(', ')}`);
  }
  if (notice.dropped.length > 0) {
    parts.push(`deleted on disk, dropped: ${notice.dropped.map(fileLabel).join(', ')}`);
  }
  return parts.join(' — ');
}

/**
 * Lays back what main restored for `workspaceId`: each draft whose request is in the mirror is
 * staged again (so its tab shows the unsaved mark and every reader sees the edit), the rest are
 * dropped, and one notice per restored project is shown. Must run once the mirror holds the
 * workspace's projects.
 */
export async function restoreUnsaved(workspaceId: string): Promise<void> {
  const result = await ipc().workspace.takeRestored(undefined);
  if (!result.ok) {
    return;
  }
  applyRestored(workspaceId, result.value);
}

/** The synchronous half of {@link restoreUnsaved}, split out for tests. */
export function applyRestored(workspaceId: string, restored: WorkspaceRestoredResponse): void {
  if (restored.workspaceId !== workspaceId) {
    return;
  }
  const projects = useProjectStore.getState();
  let restoredDrafts = 0;
  let droppedDrafts = 0;
  for (const [requestId, patch] of Object.entries(restored.drafts)) {
    if (projects.requests[requestId] === undefined) {
      droppedDrafts += 1;
      continue;
    }
    projects.editRequest(requestId, patch);
    restoredDrafts += 1;
  }
  // The REST half, counted into the same totals: to the user these are one kind of thing — the
  // edits they had not saved — and one notice for all of them is what they expect to read.
  for (const [requestId, patch] of Object.entries(restored.restDrafts)) {
    if (projects.restRequests[requestId] === undefined) {
      droppedDrafts += 1;
      continue;
    }
    projects.editRestRequest(requestId, patch);
    restoredDrafts += 1;
  }
  for (const [requestId, patch] of Object.entries(restored.grpcDrafts)) {
    if (projects.grpcRequests[requestId] === undefined) {
      droppedDrafts += 1;
      continue;
    }
    projects.editGrpcRequest(requestId, patch);
    restoredDrafts += 1;
  }
  for (const notice of restored.notices) {
    showToast(noticeMessage(notice));
  }
  if (restoredDrafts > 0 && restored.notices.length === 0) {
    showToast(
      restoredDrafts === 1
        ? 'Restored an unsaved request edit'
        : `Restored ${String(restoredDrafts)} unsaved request edits`,
    );
  }
  if (droppedDrafts > 0) {
    showToast(
      droppedDrafts === 1
        ? "Dropped an unsaved request edit: its request doesn't exist anymore"
        : `Dropped ${String(droppedDrafts)} unsaved request edits: their requests don't exist anymore`,
    );
  }
}
