/**
 * What clicking a search result does: open the thing that matched, at the place it matched.
 *
 * A request body opens its editor tab and selects the matched range; a header opens the same
 * tab with the Headers inspector showing; a definition document opens the interface viewer's
 * WSDL Content tab on that line, the same path go-to-definition uses (Task 45).
 */

import type * as Monaco from 'monaco-editor';
import type { SearchMatchWire } from '../../../shared/wire-types.js';
import { getActiveRequestEditor } from '../../editor/active-request-editor.js';
import { useEditorsStore } from '../../state/editors.js';
import { openInterfaceTab } from '../interface-editor/interface-actions.js';
import { useInterfaceEditorStore } from '../interface-editor/interface-editor-state.js';
import { openRequestTab } from '../request-editor/request-actions.js';
import { openRestRequestTab } from '../rest-editor/rest-actions.js';
import { openGrpcRequestTab } from '../grpc-editor/grpc-actions.js';

/** How long to keep waiting for a lazily-loaded request editor to mount before giving up. */
const REVEAL_TIMEOUT_MS = 2_000;
const REVEAL_POLL_MS = 50;

function selectRange(editor: Monaco.editor.IStandaloneCodeEditor, start: number, end: number): boolean {
  const model = editor.getModel();
  if (model === null || typeof model.getPositionAt !== 'function') {
    return false;
  }
  const from = model.getPositionAt(start);
  const to = model.getPositionAt(end);
  const range = {
    startLineNumber: from.lineNumber,
    startColumn: from.column,
    endLineNumber: to.lineNumber,
    endColumn: to.column,
  };
  editor.setSelection(range);
  editor.revealRangeInCenterIfOutsideViewport(range);
  return true;
}

/**
 * Selects `start`..`end` in the request editor once it is mounted. The editor area loads Monaco
 * lazily, so the very first result clicked lands before there is an editor to talk to — hence
 * the poll rather than a single attempt.
 */
function revealWhenMounted(start: number, end: number): void {
  const deadline = Date.now() + REVEAL_TIMEOUT_MS;
  const attempt = (): void => {
    const editor = getActiveRequestEditor();
    if (editor !== undefined && selectRange(editor, start, end)) {
      return;
    }
    if (Date.now() < deadline) {
      setTimeout(attempt, REVEAL_POLL_MS);
    }
  };
  attempt();
}

/** Opens whatever `match` points at, revealing the matched range or line. */
export function revealSearchMatch(match: SearchMatchWire): void {
  if (match.kind === 'document') {
    if (match.interfaceId === undefined || match.location === undefined) {
      return;
    }
    openInterfaceTab(match.interfaceId, 'wsdl');
    useInterfaceEditorStore.getState().revealSource(match.interfaceId, { location: match.location, line: match.line });
    return;
  }

  if (match.requestId === undefined) {
    return;
  }
  // A REST match opens the REST editor: its id names a REST request, which the SOAP tab would
  // open empty. The matched range is not revealed there — a REST request's searchable text is
  // assembled from its URL and tables, so an offset into it points at no single editor.
  if (match.protocol === 'rest') {
    openRestRequestTab(match.requestId, match.requestName);
    return;
  }
  if (match.protocol === 'grpc') {
    openGrpcRequestTab(match.requestId, match.requestName);
    return;
  }
  openRequestTab(match.requestId, match.requestName);
  if (match.kind === 'request-header') {
    useEditorsStore.getState().setInspector(match.requestId, 'request', 'headers');
    return;
  }
  revealWhenMounted(match.start, match.end);
}
