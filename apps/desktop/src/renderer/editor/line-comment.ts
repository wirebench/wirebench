/**
 * Toggling `//` line comments, as a pure function over lines.
 *
 * Monaco's own toggle rounds the insertion column down to a multiple of the tab size, so on a line
 * indented by two spaces with a tab size of four the `//` landed in column 1 (G15). This puts it at
 * the smallest indent of the non-blank lines, the way VS Code does, so a block keeps its shape and
 * uncommenting gives back exactly the text that was there.
 */

const MARKER = '//';

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function isCommented(line: string): boolean {
  return line.slice(indentOf(line)).startsWith(MARKER);
}

/**
 * Comments `lines` out, or uncomments them when every non-blank line is already a `//` comment.
 * Blank lines are left alone, unless there is nothing else, which comments them.
 */
export function toggleLineComments(lines: readonly string[]): string[] {
  const content = lines.filter((line) => !isBlank(line));
  if (content.length === 0) {
    return lines.map((line) => `${line}${MARKER} `);
  }
  if (content.every(isCommented)) {
    return lines.map((line) => {
      if (isBlank(line)) return line;
      const at = indentOf(line);
      const rest = line.slice(at + MARKER.length);
      return line.slice(0, at) + (rest.startsWith(' ') ? rest.slice(1) : rest);
    });
  }
  const column = Math.min(...content.map(indentOf));
  return lines.map((line) => (isBlank(line) ? line : `${line.slice(0, column)}${MARKER} ${line.slice(column)}`));
}

/** The part of a Monaco editor the toggle needs, so it can be driven by a stand-in under jsdom. */
export interface CommentableEditor {
  getSelection(): { startLineNumber: number; endLineNumber: number; endColumn: number } | null;
  getModel(): {
    getLineContent(line: number): string;
    getLineMaxColumn(line: number): number;
    getEOL(): string;
  } | null;
  executeEdits(
    source: string,
    edits: {
      range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
      text: string;
    }[],
  ): boolean;
}

/** Toggles `//` on the selected lines. A selection that ends at column 1 does not take that line. */
export function toggleCommentInEditor(editor: CommentableEditor): void {
  const selection = editor.getSelection();
  const model = editor.getModel();
  if (selection === null || model === null) return;
  const first = selection.startLineNumber;
  const last =
    selection.endLineNumber > first && selection.endColumn === 1
      ? selection.endLineNumber - 1
      : selection.endLineNumber;
  const lines: string[] = [];
  for (let line = first; line <= last; line += 1) {
    lines.push(model.getLineContent(line));
  }
  editor.executeEdits('wirebench.toggleComment', [
    {
      range: { startLineNumber: first, startColumn: 1, endLineNumber: last, endColumn: model.getLineMaxColumn(last) },
      text: toggleLineComments(lines).join(model.getEOL()),
    },
  ]);
}
