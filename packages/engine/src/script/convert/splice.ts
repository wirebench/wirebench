/**
 * Text edits over a script (spec §5.1 step 4): an edit replaces one span of the original text, so no
 * span shifts. Everything outside an edit stays byte for byte.
 */

/** Replace `text[start, end)` with `text`. */
export interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * `text` with every edit applied. The edits do not overlap; the text between them is copied once, in
 * one pass, so the time is linear in the text and the edits.
 */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  const parts: string[] = [];
  let at = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    parts.push(text.slice(at, edit.start), edit.text);
    at = edit.end;
  }
  parts.push(text.slice(at));
  return parts.join('');
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

  const body = commentLines(text.slice(start, bodyEnd), indent, (kept) => kept);

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

/**
 * The edit that comments out `text[start, end)` when that statement is the body of an `if`, `else`,
 * loop or label rather than a member of a statement list: it is wrapped in braces, so the construct
 * stays valid and still has a body. The `{` goes where the statement started (on the line before it
 * when only white space came between), the commented lines and `todos` one level deeper than that
 * line, and the `}` back at its indentation; what followed the statement stays after the `}`.
 * `fullStart` is where the statement's leading trivia begins; it is used only when it is white space
 * inside `range`.
 */
export function wrapCommentedOut(
  text: string,
  fullStart: number,
  start: number,
  end: number,
  range: { readonly from: number; readonly to: number },
  todos: readonly string[],
): Edit {
  const from = fullStart >= range.from && text.slice(fullStart, start).trim() === '' ? fullStart : start;
  const outer = /^[ \t]*/.exec(text.slice(lineStart(text, from)))?.[0] ?? '';
  const inner = outer + (outer.includes('\t') ? '\t' : '  ');
  const base = /^[ \t]*/.exec(text.slice(lineStart(text, start)))?.[0] ?? '';
  const eol = lineEndingAt(text, start);
  const body = commentLines(text.slice(start, end), base, () => inner);
  return {
    start: from,
    end,
    text:
      (from === fullStart ? ' {' : '{') +
      eol +
      todos.map((todo) => `${inner}${todo}${eol}`).join('') +
      body +
      eol +
      outer +
      '}',
  };
}

/**
 * `slice` with `// ` before each line. The first line starts at the statement and gets `base`; a
 * later line keeps its white space past `base`, and `lead` gives what replaces the part it shares.
 */
function commentLines(slice: string, base: string, lead: (kept: string) => string): string {
  const parts = slice.split(/(\r\n|\n|\r)/);
  let body = '';
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i] ?? '';
    const lineBreak = parts[i + 1] ?? '';
    if (i === 0) body += `${lead(base)}// ${line}`;
    else if (line.trim() === '') body += `${lead(base)}//`;
    else {
      const at = Math.min(base.length, /^[ \t]*/.exec(line)?.[0].length ?? 0);
      body += `${lead(line.slice(0, at))}// ${line.slice(at)}`;
    }
    body += lineBreak;
  }
  return body;
}
