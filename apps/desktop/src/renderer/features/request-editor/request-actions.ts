/**
 * The logic behind the request editor's toolbar actions — Recreate, Clone, Copy as cURL and
 * Import cURL. Kept out of `toolbar.tsx` so the same handlers back the explorer's context menu
 * and the `editor.*` palette commands, and so each one is unit-testable without a toolbar.
 */

import { showToast } from '../../components/toast.js';
import { useEditorsStore } from '../../state/editors.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';
import type { RequestCurlRequest, RequestImportCurlTarget } from '../../../shared/wire-types.js';
import { openRestRequestTab } from '../rest-editor/rest-actions.js';
import { getActiveRequestPaneHandle } from '../../editor/active-request-editor.js';

/** Which of the three Recreate menu items was chosen. */
export type RecreateMode = 'keep-values' | 'discard-values' | 'empty';

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Opens (or focuses) the editor tab for `requestId`. Without a `fallbackTitle` the request must
 * already be in the mirror; with one, the tab opens anyway — what a just-imported request needs,
 * since main's snapshot for it may not have arrived yet.
 */
export function openRequestTab(requestId: string, fallbackTitle?: string): void {
  const title = useProjectStore.getState().requests[requestId]?.name ?? fallbackTitle;
  if (title === undefined) {
    return;
  }
  useEditorsStore.getState().open({ id: `request:${requestId}`, kind: 'request', title, requestId });
}

/**
 * Regenerates the request's envelope from its operation and saves it. Main owns the merge and
 * the write, so the mirror is patched directly (`applyEnvelope`) rather than through another
 * `update-request` round trip; the pane treats that as an external replacement and drops any
 * debounced edit it was still holding.
 */
export async function recreateRequest(requestId: string, mode: RecreateMode): Promise<void> {
  // A keystroke still inside the editor's debounce is not even staged yet — run from the palette,
  // the editor never loses focus to flush it — so push it into the store before anything else.
  getActiveRequestPaneHandle()?.flush();
  // Main rebuilds the envelope from *its* model, so a staged edit has to reach it first —
  // otherwise "keep values" keeps the last saved ones and silently discards what is on screen.
  // Same rule as the WS-Security references: anything main resolves for itself cannot stay
  // staged in the renderer.
  if (!(await useProjectStore.getState().commitRequest(requestId))) {
    return;
  }
  const result = await ipc().request.recreate({
    requestId,
    keepValues: mode === 'keep-values',
    // Hand-written SOAP headers (WS-Security, routing) are never what a "recreate" is aimed at,
    // so they survive both merge modes; only "Create empty" clears them.
    keepHeaders: mode !== 'empty',
    empty: mode === 'empty',
  });
  if (!result.ok) {
    showToast(result.error.message);
    return;
  }
  const { envelopeXml, kept, added, removed } = result.value;
  // Staged rather than mirrored: main has the recreated envelope in its model but nothing has
  // been written, so the tab has to keep saying it is unsaved and Mod+S has to have something
  // to write. Saving replays an envelope main already holds, which the reconciler skips.
  useProjectStore.getState().editRequest(requestId, { envelopeXml });
  showToast(mode === 'empty' ? 'Request emptied' : `Kept ${kept} values, added ${added}, removed ${removed}`);
}

/** Clones the request under `name` and opens the copy in a new tab. */
export async function cloneRequestAs(requestId: string, name: string): Promise<void> {
  try {
    const project = useProjectStore.getState();
    const created = await project.cloneRequest(requestId);
    const trimmed = name.trim();
    if (trimmed.length > 0) {
      project.updateRequest(created, { name: trimmed });
    }
    openRequestTab(created);
  } catch (error: unknown) {
    showToast(message(error, 'Clone request failed'));
  }
}

/** Copies the `curl` command equivalent to sending this request to the clipboard. */
export async function copyAsCurl(requestId: string, shell: RequestCurlRequest['shell']): Promise<void> {
  const result = await ipc().request.curl({ requestId, shell });
  if (!result.ok) {
    showToast(result.error.message);
    return;
  }
  try {
    await navigator.clipboard.writeText(result.value.command);
    showToast(shell === 'powershell' ? 'Copied as cURL (PowerShell)' : 'Copied as cURL');
  } catch (error: unknown) {
    showToast(message(error, 'Could not copy to the clipboard'));
  }
}

/**
 * Turns a pasted `curl` command into a new request against `operation`, opens it, and reports
 * whatever the parse could not honour. Returns the new request's id, or `undefined` on failure.
 */
export async function importCurl(
  command: string,
  target: RequestImportCurlTarget,
  options: { readonly passwordRef?: string } = {},
): Promise<string | undefined> {
  const result = await ipc().request.importCurl({
    command,
    target,
    ...(options.passwordRef !== undefined ? { passwordRef: options.passwordRef } : {}),
  });
  if (!result.ok) {
    showToast(result.error.message);
    return undefined;
  }
  const { requestId, problems, basicUsername } = result.value;
  // The snapshot main broadcast for the new request may not have landed yet; refresh so the
  // tab (and the explorer row) can be opened against a mirror that actually contains it.
  const owner = target.kind === 'soap' ? target.interfaceId : target.apiId;
  const projectId = useProjectStore.getState().projectOf[owner];
  if (projectId !== undefined) {
    await useProjectStore.getState().refresh(projectId);
  }
  if (target.kind === 'rest') {
    openRestRequestTab(requestId, 'Imported request');
  } else {
    openRequestTab(requestId, 'Imported request');
  }
  const notes: string[] = [];
  if (problems.length > 0) {
    notes.push(`${String(problems.length)} problem(s)`);
  }
  // A `-u` with no password pasted leaves the request configured but unable to authenticate, which
  // is worth saying once rather than leaving the user to a 401.
  if (basicUsername !== undefined && options.passwordRef === undefined) {
    notes.push(`set a password for “${basicUsername}” on the Auth tab`);
  }
  showToast(notes.length === 0 ? 'Imported cURL command' : `Imported — ${notes.join('; ')}`);
  return requestId;
}
