/**
 * Markers on a `tools/call`'s Arguments editor (#79). Monaco's JSON language here only tokenises, so
 * the text as typed is checked in main (`request.mcpArgumentsCheck`), as JSON and then against the
 * tool's `inputSchema`, and each problem comes back as a marker: a schema mismatch as a warning, at
 * its JSON pointer, and text that is not JSON as an error where the parse stopped.
 */
import type * as Monaco from 'monaco-editor';
import { contractRange } from '../../editor/markers.js';
import { ipc } from '../../state/ipc-client.js';
import type { McpArgumentsProblemWire } from '@shared/kinds/mcp/wire.js';

/** The owner Monaco files the Arguments editor's markers under. */
export const MCP_ARGUMENTS_MARKER_OWNER = 'wirebench-mcp-arguments';

/** How long typing must pause before the arguments are checked. */
export const MCP_ARGUMENTS_CHECK_DEBOUNCE_MS = 300;

type MarkerRange = Pick<Monaco.editor.IMarkerData, 'startLineNumber' | 'startColumn' | 'endLineNumber' | 'endColumn'>;

/** The first line, whole: where a problem about the arguments as a whole sits. */
function firstLineRange(text: string): MarkerRange {
  const firstLine = text.split('\n', 1)[0] ?? '';
  return { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: Math.max(firstLine.length + 1, 2) };
}

/** Where `problem` sits in `text`. */
function rangeOf(problem: McpArgumentsProblemWire, text: string): MarkerRange {
  if (problem.position !== undefined) {
    const { line, column } = problem.position;
    return { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column + 1 };
  }
  // The root pointer would span the whole text; the object's first line says as much, quieter.
  return problem.pointer === '' ? firstLineRange(text) : contractRange(text, problem.pointer);
}

/** Main's problems as Monaco markers against `text`, the text they were found in. */
export function mcpArgumentsMarkerData(
  severities: typeof Monaco.MarkerSeverity,
  problems: readonly McpArgumentsProblemWire[],
  text: string,
): Monaco.editor.IMarkerData[] {
  return problems.map((problem) => ({
    severity: problem.severity === 'error' ? severities.Error : severities.Warning,
    message: problem.message,
    source: 'mcp',
    ...(problem.keyword !== undefined ? { code: problem.keyword } : {}),
    ...rangeOf(problem, text),
  }));
}

/**
 * Asks main to check `text` against `schema` and puts the answer on `model` as markers. An answer
 * for text the model no longer holds is dropped: a later check is already on its way.
 *
 * @returns whether markers were set
 */
export async function refreshMcpArgumentsMarkers(
  monacoNS: typeof Monaco | undefined,
  model: Monaco.editor.ITextModel | null | undefined,
  text: string,
  schema: unknown,
): Promise<boolean> {
  if (model == null) return false;
  const version = model.getVersionId();
  const result = await ipc().request.mcpArgumentsCheck({ text, ...(schema !== undefined ? { schema } : {}) });
  if (!result.ok || model.isDisposed() || model.getVersionId() !== version) return false;
  // The jsdom test double for Monaco carries no `editor` namespace; there is nothing to mark then.
  if (monacoNS === undefined || typeof (monacoNS as Partial<typeof Monaco>).editor?.setModelMarkers !== 'function') {
    return false;
  }
  monacoNS.editor.setModelMarkers(
    model,
    MCP_ARGUMENTS_MARKER_OWNER,
    mcpArgumentsMarkerData(monacoNS.MarkerSeverity, result.value.problems, text),
  );
  return true;
}
