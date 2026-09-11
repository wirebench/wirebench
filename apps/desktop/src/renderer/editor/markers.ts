import type * as Monaco from 'monaco-editor';
import type { ValidationProblemWire } from '../../shared/wire-types.js';

/**
 * The `setModelMarkers` owner every validation marker is filed under. Owning a namespace of
 * our own means a validation run replaces exactly its own markers and never touches anything
 * Monaco's own language services put on the model.
 */
export const VALIDATION_MARKER_OWNER = 'wirebench-validation';

/** Monaco's `MarkerSeverity.Error`/`.Warning`, inlined so this module needs no Monaco at import time. */
const SEVERITY = { error: 8, warning: 4 } as const;

/** The little of a Monaco model {@link toMarkerData} reads, so it can be exercised without Monaco. */
export interface MarkerModel {
  getLineCount(): number;
  getLineMaxColumn(lineNumber: number): number;
}

/**
 * Converts validation problems into Monaco marker data.
 *
 * A problem with no position is pinned to line 1 (it is about the message as a whole — a
 * schema set that would not compile, say). A problem with a line but no column spans that
 * whole line, which is as precise as libxml2 gets.
 *
 * @param problems the findings from `validate.message`
 * @param model the model the markers will be set on, for line lengths
 */
export function toMarkerData(
  problems: readonly ValidationProblemWire[],
  model: MarkerModel,
): Monaco.editor.IMarkerData[] {
  const lineCount = Math.max(model.getLineCount(), 1);
  return problems.map((problem) => {
    const startLineNumber = Math.min(Math.max(problem.line ?? 1, 1), lineCount);
    const endLineNumber = Math.min(Math.max(problem.endLine ?? startLineNumber, startLineNumber), lineCount);
    const startColumn = Math.max(problem.column ?? 1, 1);
    const endColumn = problem.endColumn ?? model.getLineMaxColumn(endLineNumber);
    return {
      severity: SEVERITY[problem.severity],
      message: problem.message,
      code: problem.code,
      source: problem.source,
      startLineNumber,
      startColumn,
      endLineNumber,
      endColumn: Math.max(endColumn, startColumn + (endLineNumber === startLineNumber ? 1 : 0)),
    };
  });
}

/** The slice of the Monaco namespace the marker calls need. */
export type MarkerApi = Pick<typeof Monaco, 'editor'>;

/**
 * The mounted editor's Monaco namespace, handed over by the request pane's `onMount`.
 *
 * Registered rather than imported on purpose: importing `monaco-editor` here would drag the
 * whole bundle into every module that merely wants to *record* problems (the Problems view,
 * the send flow), and into every test that renders one.
 */
let markerApi: MarkerApi | undefined;

/**
 * Whether `globalThis.__wirebenchMonaco` should be exposed at all: in a dev build
 * (`import.meta.env.DEV`), or in a production build launched for e2e testing, where main sets
 * `WIREBENCH_E2E=1` and the preload mirrors it onto `window.wirebench.env.e2e` (a sandboxed
 * renderer has no `process.env` of its own to read). Neither is true in a real user's build, so
 * the handle never reaches one.
 */
function monacoHandleAllowed(): boolean {
  if (import.meta.env.DEV) {
    return true;
  }
  const api = (globalThis as { wirebench?: { env?: { e2e?: boolean } } }).wirebench;
  return api?.env?.e2e === true;
}

/**
 * Registers the Monaco namespace marker calls go through. Call from the editor's `onMount`.
 *
 * In a dev build, or a production build launched for e2e testing (see
 * {@link monacoHandleAllowed}), also parks the namespace on `globalThis.__wirebenchMonaco`, the
 * only way an e2e spec can read back the markers a validation run produced
 * (`monaco.editor.getModelMarkers`). It is a handle to a bundle the renderer has already
 * loaded — no privileged API, nothing the page could not reach on its own — but a real user's
 * build never sets it at all.
 */
export function setMarkerApi(api: MarkerApi | undefined): void {
  markerApi = api;
  if (monacoHandleAllowed()) {
    (globalThis as unknown as { __wirebenchMonaco?: MarkerApi | undefined }).__wirebenchMonaco = api;
  }
}

/**
 * Replaces this owner's markers on `model` with `problems`. Passing an empty list clears them,
 * which is what a request does when its envelope changes: last run's markers say nothing about
 * the text as it stands now.
 *
 * @param model the request (or response) editor's model
 * @param problems the findings to show
 * @param monaco the Monaco namespace; defaults to the app's configured instance
 */
export function setValidationMarkers(
  model: (Monaco.editor.ITextModel & MarkerModel) | null | undefined,
  problems: readonly ValidationProblemWire[],
  monaco: MarkerApi | undefined = markerApi,
): void {
  // The jsdom test double for Monaco carries no `editor` namespace at all, and a pane may mount
  // before anything registers one; either way there is nothing to mark.
  if (model === null || model === undefined || typeof monaco?.editor?.setModelMarkers !== 'function') {
    return;
  }
  monaco.editor.setModelMarkers(model, VALIDATION_MARKER_OWNER, toMarkerData(problems, model));
}
