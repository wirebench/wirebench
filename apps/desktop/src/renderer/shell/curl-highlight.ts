/**
 * Splits a generated `curl` command into coloured spans for the Code panel.
 *
 * Presentation only, and deliberately so: the command is built in main by the engine's `toCurl`,
 * and this never rewrites a character of it. Concatenating every token of every line, with a
 * newline between lines, reproduces the input exactly — the panel shows what would go on the
 * wire, so a highlighter that could drop or alter text would be a correctness bug, not a style
 * one. `highlightCurl` is total: it never throws, whatever it is handed.
 */

/** What one span of a command is, as far as the panel needs to colour it. */
export type CurlTokenKind = 'command' | 'flag' | 'string' | 'punctuation' | 'body' | 'plain';

/** One coloured span. */
export interface CurlToken {
  readonly text: string;
  readonly kind: CurlTokenKind;
}

/** The spans of one line, in order. */
export type CurlLine = readonly CurlToken[];

/** `--data-binary @- <<'EOF'` — the POSIX form, capturing the word that ends the body. */
const HEREDOC_START = /<<\s*'?([A-Za-z_]\w*)'?\s*$/;

/** `--data-binary @'` — the PowerShell here-string, which always ends at `'@`. */
const HERESTRING_START = /@'\s*$/;

/** The line that closes a PowerShell here-string. */
const HERESTRING_END = "'@";

/**
 * Scans one line of shell, losslessly. `curl`/`curl.exe` leads, words starting with `-` are
 * flags, quoted spans are strings, and a lone trailing `\` or backtick is the continuation.
 */
function scanLine(line: string): CurlToken[] {
  const tokens: CurlToken[] = [];
  let atStart = true;
  let i = 0;

  const push = (text: string, kind: CurlTokenKind): void => {
    if (text.length === 0) {
      return;
    }
    // Runs of one kind merge, so a line of plain whitespace and words is a few spans, not many.
    const last = tokens[tokens.length - 1];
    if (last !== undefined && last.kind === kind) {
      tokens[tokens.length - 1] = { text: last.text + text, kind };
      return;
    }
    tokens.push({ text, kind });
  };

  while (i < line.length) {
    const char = line[i] as string;

    if (/\s/.test(char)) {
      push(char, 'plain');
      i += 1;
      continue;
    }

    if (char === "'") {
      push(line.slice(i, (i = endOfQuoted(line, i))), 'string');
      atStart = false;
      continue;
    }

    let end = i;
    while (end < line.length && !/[\s']/.test(line[end] as string)) {
      end += 1;
    }
    const word = line.slice(i, end);
    push(
      word,
      atStart && (word === 'curl' || word === 'curl.exe')
        ? 'command'
        : word.startsWith('-')
          ? 'flag'
          : word === '\\' || word === '`'
            ? 'punctuation'
            : 'plain',
    );
    atStart = false;
    i = end;
  }

  return tokens;
}

/**
 * Where the quoted span opening at `start` ends, one past its closing quote. Both shells escape
 * an embedded quote rather than ending the span: POSIX closes, emits `\'` and reopens (`'\''`),
 * PowerShell doubles it (`''`) — so neither sequence terminates the string.
 */
function endOfQuoted(line: string, start: number): number {
  let i = start + 1;
  for (;;) {
    const close = line.indexOf("'", i);
    if (close === -1) {
      return line.length;
    }
    i = close + 1;
    if (line.startsWith("\\''", i)) {
      i += 3;
      continue;
    }
    if (line[i] === "'") {
      i += 1;
      continue;
    }
    return i;
  }
}

/**
 * The command, line by line, as coloured spans. The request body — everything between a heredoc
 * or here-string opener and its terminator — is one `body` span per line: it is XML the user
 * wrote, not shell, so shell rules must not be applied to it.
 */
export function highlightCurl(command: string): readonly CurlLine[] {
  const lines: CurlLine[] = [];
  /** The line that closes the body currently being read, or `undefined` outside a body. */
  let terminator: string | undefined;

  for (const line of command.split('\n')) {
    if (terminator !== undefined) {
      if (line.trim() === terminator) {
        terminator = undefined;
        lines.push([{ text: line, kind: 'punctuation' }]);
      } else {
        lines.push([{ text: line, kind: 'body' }]);
      }
      continue;
    }

    lines.push(scanLine(line));
    const heredoc = HEREDOC_START.exec(line);
    if (heredoc !== null) {
      terminator = heredoc[1];
    } else if (HERESTRING_START.test(line)) {
      terminator = HERESTRING_END;
    }
  }

  return lines;
}
