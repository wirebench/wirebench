/**
 * Text edits over a script (spec §5.1 step 4): an edit replaces one span, and edits are applied from
 * the end of the text backwards so no span shifts. Everything outside an edit stays byte for byte.
 */

/** Replace `text[start, end)` with `text`. */
export interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** `text` with every edit applied, from the end backwards. The edits do not overlap. */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

const LINE_BREAK = /\r\n|\n|\r/g;

/** Where the line holding `at` ends: the index of its line break, or the text's length. */
function lineEnd(text: string, at: number): { index: number; eol: string | undefined } {
  LINE_BREAK.lastIndex = at;
  const found = LINE_BREAK.exec(text);
  return found === null ? { index: text.length, eol: undefined } : { index: found.index, eol: found[0] };
}

/** Where the line holding `at` starts. */
function lineStart(text: string, at: number): number {
  return Math.max(text.lastIndexOf('\n', at - 1), text.lastIndexOf('\r', at - 1)) + 1;
}

/** The line break the line holding `at` ends with, else the text's first, else `\n`. */
export function lineEndingAt(text: string, at: number): string {
  return lineEnd(text, at).eol ?? lineEnd(text, 0).eol ?? '\n';
}

/**
 * The edit that comments out `text[start, end)` (one statement) line by line, with `todos` above it
 * at the statement's indentation (spec §5.2). Each line gets `// ` after the statement's indentation
 * and keeps its own line end. Code that shares the statement's first or last line is moved to a
 * line of its own, so only the statement is commented out; a line comment after it goes with it.
 * The edit stays inside `range`.
 */
export function commentOut(
  text: string,
  start: number,
  end: number,
  range: { readonly from: number; readonly to: number },
  todos: readonly string[],
): Edit {
  const first = lineStart(text, start);
  const indent = /^[ \t]*/.exec(text.slice(first))?.[0] ?? '';
  const eol = lineEndingAt(text, start);
  const ownFirstLine = first >= range.from && text.slice(first, start).trim() === '';
  const last = lineEnd(text, end).index;
  const after = text.slice(end, last);
  const ownLastLine = last <= range.to && (after.trim() === '' || after.trimStart().startsWith('//'));
  const bodyEnd = ownLastLine ? last : end;

  const parts = text.slice(start, bodyEnd).split(/(\r\n|\n|\r)/);
  let body = '';
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i] ?? '';
    const lineBreak = parts[i + 1] ?? '';
    if (i === 0) body += `${indent}// ${line}`;
    else if (line.trim() === '') body += `${indent}//`;
    else {
      const at = Math.min(indent.length, /^[ \t]*/.exec(line)?.[0].length ?? 0);
      body += `${line.slice(0, at)}// ${line.slice(at)}`;
    }
    body += lineBreak;
  }

  return {
    start: ownFirstLine ? first : start,
    end: ownLastLine ? last : end + (after.length - after.trimStart().length),
    text:
      (ownFirstLine ? '' : eol) +
      todos.map((todo) => `${indent}${todo}${eol}`).join('') +
      body +
      (ownLastLine ? '' : eol + indent),
  };
}
