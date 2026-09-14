/**
 * Finds the heredoc or here-string body embedded in a pasted `curl` command.
 *
 * Both cURL parsers (`http/curl.ts` for SOAP, `rest/curl.ts` for REST) need this and nothing else
 * in common, so it lives here rather than in either. It scans instead of matching a regex: the
 * pattern this replaces, `/<<\\s*'?(\\w+)'?\\r?\\n([\\s\\S]*?)\\r?\\n\\1/`, backtracks its lazy body against a
 * backreference for every candidate `<<`, which is O(n²) on a command that a user pastes and can
 * therefore be anything.
 */

/** A body found by {@link findHeredoc} or {@link findHereString}: what to keep, and where it sat. */
export interface EmbeddedBody {
  readonly body: string;
  /** Offset of the opener (`<<` or `@'`) in the source text. */
  readonly start: number;
  /** Offset just past the closing delimiter line. */
  readonly end: number;
}

/** Offset just past a `\n` or `\r\n` at `at`, or -1 when `at` is not a line end. */
function lineEndAfter(text: string, at: number): number {
  if (text.startsWith('\r\n', at)) {
    return at + 2;
  }
  return text[at] === '\n' ? at + 1 : -1;
}

/**
 * Locates a POSIX heredoc: `<<EOF` or `<<'EOF'`, a newline, the body, a newline and `EOF` on a line
 * of its own. The body is everything between the opening line and the first line that is exactly
 * the delimiter; an opener with no such closing line is not a heredoc.
 */
export function findHeredoc(text: string): EmbeddedBody | undefined {
  let from = 0;
  for (;;) {
    const open = text.indexOf('<<', from);
    if (open === -1) {
      return undefined;
    }
    let cursor = open + 2;
    while (text[cursor] === ' ' || text[cursor] === '\t') {
      cursor += 1;
    }
    const quoted = text[cursor] === "'";
    if (quoted) {
      cursor += 1;
    }
    const wordStart = cursor;
    while (cursor < text.length && /\w/.test(text[cursor] as string)) {
      cursor += 1;
    }
    const delimiter = text.slice(wordStart, cursor);
    if (quoted && text[cursor] === "'") {
      cursor += 1;
    }
    const bodyStart = lineEndAfter(text, cursor);
    if (delimiter === '' || bodyStart === -1) {
      from = open + 2;
      continue;
    }
    const closeAt = text.indexOf(`\n${delimiter}`, bodyStart);
    if (closeAt === -1) {
      return undefined;
    }
    const bodyEnd = text[closeAt - 1] === '\r' ? closeAt - 1 : closeAt;
    return { body: text.slice(bodyStart, bodyEnd), start: open, end: closeAt + 1 + delimiter.length };
  }
}

/** Locates a PowerShell here-string: `@'`, a newline, the body, a newline and `'@`. */
export function findHereString(text: string): EmbeddedBody | undefined {
  const open = text.indexOf("@'");
  if (open === -1) {
    return undefined;
  }
  const bodyStart = lineEndAfter(text, open + 2);
  if (bodyStart === -1) {
    return undefined;
  }
  const closeAt = text.indexOf("\n'@", bodyStart);
  if (closeAt === -1) {
    return undefined;
  }
  const bodyEnd = text[closeAt - 1] === '\r' ? closeAt - 1 : closeAt;
  return { body: text.slice(bodyStart, bodyEnd), start: open, end: closeAt + 3 };
}
