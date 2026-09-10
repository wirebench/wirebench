import type * as Monaco from 'monaco-editor';
import type { RequestPaneHandle } from '../features/request-editor/request-pane.js';

/**
 * The Monaco instance currently backing the request editor, so editor-scoped commands
 * (`editor.formatXml`, `editor.gotoLine`, …) registered in the global command palette can
 * reach it without threading a ref through every layer between the palette and the pane.
 * There is at most one request editor mounted at a time — request/response panes are not
 * split — so a single module-level slot is enough.
 */
let current: Monaco.editor.IStandaloneCodeEditor | undefined;
let currentInterfaceId: string | undefined;
let currentHandle: RequestPaneHandle | undefined;

/** Registers `editor` (and the interface it belongs to) as active. Call from the pane's `onMount`/unmount. */
export function setActiveRequestEditor(
  editor: Monaco.editor.IStandaloneCodeEditor | undefined,
  interfaceId?: string,
  handle?: RequestPaneHandle,
): void {
  current = editor;
  currentInterfaceId = editor === undefined ? undefined : interfaceId;
  currentHandle = handle;
}

/** The mounted request editor, or `undefined` when no request tab is open. */
export function getActiveRequestEditor(): Monaco.editor.IStandaloneCodeEditor | undefined {
  return current;
}

/** The interface id backing the mounted request editor, or `undefined`. */
export function getActiveInterfaceId(): string | undefined {
  return currentInterfaceId;
}

/** The imperative handle of the mounted request pane, or `undefined` when no request tab is open. */
export function getActiveRequestPaneHandle(): RequestPaneHandle | undefined {
  return currentHandle;
}
