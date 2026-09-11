/**
 * ⌥←/⌥→ — "previous/next element value", SoapUI's XML-editor parity move. The ranges come from
 * the very same tolerant model the Form and Outline views are built on
 * (`views/xml-model.ts`), so what the caret jumps between is exactly what those views let you
 * edit: a leaf element's text content, and each attribute value.
 *
 * The range arithmetic is pure and lives here; the Monaco half is a thin wrapper at the bottom.
 */

import type * as Monaco from 'monaco-editor';
import { getActiveRequestEditor } from '../../editor/active-request-editor.js';
import { parseXmlOutline } from './views/xml-model.js';
import type { OutlineNode, TextRange } from './views/xml-model.js';

/** Which way {@link nextValueRange} steps. */
export type ValueDirection = 'next' | 'previous';

function collect(node: OutlineNode, out: TextRange[]): void {
  for (const attribute of node.attributes) {
    // Namespace declarations are envelope plumbing, never a value a user steps through.
    if (attribute.name !== 'xmlns' && !attribute.name.startsWith('xmlns:')) {
      out.push(attribute.valueRange);
    }
  }
  if (node.text !== undefined) {
    out.push(node.text.range);
  }
  for (const child of node.children) {
    collect(child, out);
  }
}

/**
 * Every steppable value range in `xml`, in document order. Elements with element children have
 * no text range of their own — only leaves do — which is what makes this "element *value*"
 * navigation rather than element navigation.
 */
export function valueRanges(xml: string): readonly TextRange[] {
  const { root } = parseXmlOutline(xml);
  if (root === undefined) {
    return [];
  }
  const out: TextRange[] = [];
  collect(root, out);
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * The range to move to from caret position `offset`, or `undefined` when there are none.
 * Stepping past either end wraps around, so holding ⌥→ cycles the document rather than
 * stopping dead in a corner of it.
 */
export function nextValueRange(
  ranges: readonly TextRange[],
  offset: number,
  direction: ValueDirection,
): TextRange | undefined {
  if (ranges.length === 0) {
    return undefined;
  }
  if (direction === 'next') {
    return ranges.find((range) => range.start > offset) ?? ranges[0];
  }
  const earlier = ranges.filter((range) => range.start < offset);
  return earlier[earlier.length - 1] ?? ranges[ranges.length - 1];
}

function selectRange(editor: Monaco.editor.IStandaloneCodeEditor, model: Monaco.editor.ITextModel, range: TextRange) {
  const start = model.getPositionAt(range.start);
  const end = model.getPositionAt(range.end);
  editor.setSelection({
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column,
  });
  editor.revealRangeInCenterIfOutsideViewport({
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column,
  });
  editor.focus();
}

/**
 * Moves the request editor's selection to the adjacent element value.
 *
 * @returns `true` when the caret moved; `false` when no editor is mounted, its model has no
 * parseable root, or the Monaco double under test lacks the offset/position API.
 */
export function moveToAdjacentValue(direction: ValueDirection): boolean {
  const editor = getActiveRequestEditor();
  const model = editor?.getModel();
  if (editor === undefined || model === null || model === undefined) {
    return false;
  }
  if (typeof model.getPositionAt !== 'function' || typeof model.getOffsetAt !== 'function') {
    return false;
  }
  const ranges = valueRanges(model.getValue());
  const offset = model.getOffsetAt(editor.getPosition() ?? { lineNumber: 1, column: 1 });
  const target = nextValueRange(ranges, offset, direction);
  if (target === undefined) {
    return false;
  }
  selectRange(editor, model, target);
  return true;
}
