import type * as Monaco from 'monaco-editor';

/**
 * The Monaco instance currently backing the response editor, mirroring `active-request-editor.ts`.
 * A validation problem found in a *response* must reveal its position in the response's own XML
 * view, never in the request editor next to it — see `revealProblem` in `validate-actions.ts`,
 * which is what this module exists for.
 */
let current: Monaco.editor.IStandaloneCodeEditor | undefined;

/** Registers `editor` as the mounted response editor. Call from the response pane's `onMount`/unmount. */
export function setActiveResponseEditor(editor: Monaco.editor.IStandaloneCodeEditor | undefined): void {
  current = editor;
}

/** The mounted response editor, or `undefined` when no response XML view is on screen. */
export function getActiveResponseEditor(): Monaco.editor.IStandaloneCodeEditor | undefined {
  return current;
}
