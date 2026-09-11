/**
 * The renderer half of message validation: calls `validate.message`, files the findings in the
 * Problems store, and mirrors them onto the request editor as Monaco markers.
 *
 * Kept out of the panes and commands so the toolbar button, the palette command, the context
 * menu and the auto-validate-on-send gate all take exactly the same path.
 */

import type { ValidationProblemWire } from '../../../shared/wire-types.js';
import { showToast } from '../../components/toast.js';
import { getActiveRequestEditor } from '../../editor/active-request-editor.js';
import { setValidationMarkers } from '../../editor/markers.js';
import { explorerActions } from '../explorer/explorer-actions.js';
import { useEditorsStore } from '../../state/editors.js';
import { ipc } from '../../state/ipc-client.js';
import { useProblemsStore } from '../../state/problems.js';

/** Which half of the exchange a validation run covers. */
export type ValidationDirection = 'request' | 'response';

/** The Problems-store group one validation run owns; a re-run replaces exactly this group. */
export function validationGroupId(requestId: string, direction: ValidationDirection): string {
  return `validation:${requestId}:${direction}`;
}

/** The request behind the active editor tab, or `undefined` when none is a request tab. */
function activeRequestId(): string | undefined {
  const { tabs, activeId } = useEditorsStore.getState();
  return tabs.find((tab) => tab.id === activeId && tab.kind === 'request')?.requestId;
}

/** Mirrors `problems` onto the request editor, but only while that request is the one on screen. */
function syncMarkers(
  requestId: string,
  direction: ValidationDirection,
  problems: readonly ValidationProblemWire[],
): void {
  if (direction !== 'request' || activeRequestId() !== requestId) {
    return;
  }
  setValidationMarkers(getActiveRequestEditor()?.getModel(), problems);
}

/**
 * Validates one message and records the result.
 *
 * @param requestId the saved request to validate
 * @param direction `request` validates the envelope being edited, `response` the last response
 * @param xml the text to validate; defaults (in main) to the saved envelope
 * @returns the findings, so a caller can gate on them (see the auto-validate-on-send path)
 */
export async function runValidation(
  requestId: string,
  direction: ValidationDirection,
  xml?: string,
): Promise<readonly ValidationProblemWire[]> {
  const result = await ipc().validate.message({
    requestId,
    direction,
    ...(xml !== undefined ? { xml } : {}),
  });

  if (!result.ok) {
    // A failure to validate is itself worth showing: it means the interface is not loaded, or
    // the request no longer maps to an operation.
    const problems: ValidationProblemWire[] = [
      { severity: 'error', code: result.error.code, message: result.error.message, source: 'structure' },
    ];
    useProblemsStore.getState().setValidation(validationGroupId(requestId, direction), requestId, problems);
    syncMarkers(requestId, direction, []);
    return problems;
  }

  useProblemsStore.getState().setValidation(validationGroupId(requestId, direction), requestId, result.value.problems);
  syncMarkers(requestId, direction, result.value.problems);
  return result.value.problems;
}

/**
 * Drops one request's validation findings (and its markers). Called when the envelope changes:
 * the last run described text that no longer exists, and stale markers are worse than none.
 */
export function clearValidation(requestId: string, direction?: ValidationDirection): void {
  const directions: ValidationDirection[] = direction === undefined ? ['request', 'response'] : [direction];
  for (const each of directions) {
    useProblemsStore.getState().clear(validationGroupId(requestId, each));
  }
  syncMarkers(requestId, 'request', []);
}

/** The toast one finished validation run shows. */
function summarize(problems: readonly ValidationProblemWire[]): string {
  const errors = problems.filter((problem) => problem.severity === 'error').length;
  const warnings = problems.length - errors;
  if (problems.length === 0) {
    return 'No validation problems found.';
  }
  const parts = [
    ...(errors > 0 ? [`${String(errors)} error${errors === 1 ? '' : 's'}`] : []),
    ...(warnings > 0 ? [`${String(warnings)} warning${warnings === 1 ? '' : 's'}`] : []),
  ];
  return `Validation found ${parts.join(' and ')}.`;
}

/**
 * Validates one message and reports the outcome in a toast — what the `request.validate` /
 * `response.validate` commands, the toolbar button and the context menu all call.
 */
export async function validateAndReport(
  requestId: string,
  direction: ValidationDirection,
  xml?: string,
): Promise<readonly ValidationProblemWire[]> {
  const problems = await runValidation(requestId, direction, xml);
  showToast(summarize(problems));
  return problems;
}

/** Opens (or focuses) the request a problem belongs to and selects the line it points at. */
export function revealProblem(requestId: string, line?: number, column?: number): void {
  explorerActions.openRequest(requestId);
  if (line === undefined) {
    return;
  }
  // The tab may only mount on the next render, so the reveal waits a turn for the editor.
  setTimeout(() => {
    const editor = getActiveRequestEditor();
    const model = editor?.getModel();
    if (editor === undefined || model === null || model === undefined) {
      return;
    }
    const lineNumber = Math.min(Math.max(line, 1), model.getLineCount());
    const range = {
      startLineNumber: lineNumber,
      startColumn: Math.max(column ?? 1, 1),
      endLineNumber: lineNumber,
      endColumn: model.getLineMaxColumn(lineNumber),
    };
    editor.revealRangeInCenter(range);
    editor.setSelection(range);
    editor.focus();
  }, 0);
}
