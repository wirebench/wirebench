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
import type { WorkspaceRestoredResponse } from '@shared/wire-types.js';
import type { UnsavedRestoreNoticeWire } from '@shared/wire-base.js';
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
  const { requests, restRequests, grpcRequests, wsRequests, mcpRequests } = useDraftsStore.getState();
  await ipc().workspace.stashDrafts({
    workspaceId,
    requests: { ...requests },
    restRequests: { ...restRequests },
    grpcRequests: { ...grpcRequests },
    wsRequests: { ...wsRequests },
    mcpRequests: { ...mcpRequests },
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
      state.grpcRequests === previous.grpcRequests &&
      state.wsRequests === previous.wsRequests &&
      state.mcpRequests === previous.mcpRequests
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

/** Request names as a sentence lists them: `A`, `A and B`, `A, B and C`, `A, B, C and 2 more`. */
function nameList(names: readonly string[]): string {
  const shown = names.length > 3 ? names.slice(0, 3) : names.slice(0, -1);
  const last = names.length > 3 ? `${String(names.length - 3)} more` : names[names.length - 1];
  return shown.length === 0 ? (last ?? '') : `${shown.join(', ')} and ${last ?? ''}`;
}

/**
 * The sentence one project's restore notice reads as, given the requests whose drafts were laid back in it; or
 * `undefined` when there is nothing to tell. A project main restored with no request edit laid back, nothing changed
 * on disk and nothing dropped leaves no mark on any tab, so it is not announced: its project tab still says
 * *Unsaved changes*.
 */
export function noticeMessage(notice: UnsavedRestoreNoticeWire, requests: readonly string[] = []): string | undefined {
  if (notice.status === 'failed') {
    return `Couldn't restore unsaved changes in ${notice.projectName}${notice.message !== undefined ? `: ${notice.message}` : ''}`;
  }
  if (requests.length === 0 && notice.conflicts.length === 0 && notice.dropped.length === 0) {
    return undefined;
  }
  const parts = [
    requests.length > 0
      ? `Restored unsaved changes to ${nameList(requests)} in ${notice.projectName}`
      : `Restored unsaved changes in ${notice.projectName}`,
  ];
  if (notice.conflicts.length > 0) {
    parts.push(`also changed on disk, kept yours: ${notice.conflicts.map(fileLabel).join(', ')}`);
  }
  if (notice.dropped.length > 0) {
    parts.push(`deleted on disk, dropped: ${notice.dropped.map(fileLabel).join(', ')}`);
  }
  return parts.join(' — ');
}

/** `null` in a patch clears a field the mirror then holds as absent. */
function sameValue(current: unknown, next: unknown): boolean {
  return JSON.stringify(current ?? null) === JSON.stringify(next ?? null);
}

/**
 * Whether laying `patch` over `entity` changes anything: a draft equal to what is saved (one stashed after the
 * edit was saved, or typed back to the saved text) leaves no unsaved mark, so it is not laid back or announced.
 * A patch field the entity does not hold by that name counts as a change.
 */
export function patchChanges(entity: object, patch: object): boolean {
  const current = entity as Record<string, unknown>;
  return Object.entries(patch).some(
    ([key, value]) => value !== undefined && (!Object.hasOwn(current, key) || !sameValue(current[key], value)),
  );
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
  /** The names of the requests a draft was laid back onto, by project id (`''` when the project is unknown). */
  const laidBack = new Map<string, string[]>();
  let droppedDrafts = 0;
  const layBack = <E extends { readonly name: string }, P extends object>(
    entities: Readonly<Record<string, E>>,
    drafts: Readonly<Record<string, P>>,
    edit: (requestId: string, patch: P) => void,
  ): void => {
    for (const [requestId, patch] of Object.entries(drafts)) {
      const entity = entities[requestId];
      if (entity === undefined) {
        droppedDrafts += 1;
        continue;
      }
      if (!patchChanges(entity, patch)) {
        continue;
      }
      edit(requestId, patch);
      const projectId = projects.projectOf[requestId] ?? '';
      // A staged rename is the name the tab shows.
      const renamed = (patch as { readonly name?: unknown }).name;
      const name = typeof renamed === 'string' ? renamed : entity.name;
      laidBack.set(projectId, [...(laidBack.get(projectId) ?? []), name]);
    }
  };
  // Every protocol's drafts count into the same notices: to the user these are one kind of thing — the edits
  // they had not saved.
  layBack(projects.requests, restored.drafts, projects.editRequest);
  layBack(projects.restRequests, restored.restDrafts, projects.editRestRequest);
  layBack(projects.grpcRequests, restored.grpcDrafts, projects.editGrpcRequest);
  layBack(projects.wsRequests, restored.wsDrafts, projects.editWsRequest);
  layBack(projects.mcpRequests, restored.mcpDrafts, projects.editMcpRequest);
  for (const notice of restored.notices) {
    const message = noticeMessage(notice, laidBack.get(notice.projectId) ?? []);
    laidBack.delete(notice.projectId);
    if (message !== undefined) {
      showToast(message);
    }
  }
  for (const [projectId, names] of laidBack) {
    const projectName = projects.projects[projectId]?.name;
    showToast(
      projectName === undefined
        ? `Restored unsaved changes to ${nameList(names)}`
        : `Restored unsaved changes to ${nameList(names)} in ${projectName}`,
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
