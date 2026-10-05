/**
 * The `import` statements of a `.proto` file, found without parsing it: the readers that gather a
 * definition's files (picked files, a URL, an OpenCollection folder) need only the import targets
 * to know what to read next, and the engine's loader parses everything once they are all in hand.
 *
 * One pass over the text, character by character, so a hostile file costs time in proportion to its
 * size: comments and string literals are skipped whole, and an `import` counts only where a
 * statement starts, so neither a commented-out import nor the word in an option string is followed.
 */

/** A token of the scan: an identifier, a string literal's raw content, or one other character. */
type Token =
  | { readonly kind: 'ident'; readonly text: string }
  | { readonly kind: 'string'; readonly text: string }
  | { readonly kind: 'punct'; readonly text: string };

function isIdentStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function isIdentPart(code: number): boolean {
  return isIdentStart(code) || (code >= 48 && code <= 57) || code === 46;
}

function isSpace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13);
}

/** The tokens of `text`, with whitespace and comments dropped. */
function* tokens(text: string): Generator<Token> {
  const end = text.length;
  let at = 0;
  while (at < end) {
    const code = text.charCodeAt(at);
    if (isSpace(code)) {
      at += 1;
      continue;
    }
    if (code === 47 && text.charCodeAt(at + 1) === 47) {
      const newline = text.indexOf('\n', at + 2);
      at = newline === -1 ? end : newline + 1;
      continue;
    }
    if (code === 47 && text.charCodeAt(at + 1) === 42) {
      const close = text.indexOf('*/', at + 2);
      at = close === -1 ? end : close + 2;
      continue;
    }
    if (code === 34 || code === 39) {
      let close = at + 1;
      while (close < end && text.charCodeAt(close) !== code) {
        // A backslash escapes the next character, the closing quote included.
        close += text.charCodeAt(close) === 92 ? 2 : 1;
      }
      yield { kind: 'string', text: text.slice(at + 1, Math.min(close, end)) };
      at = close + 1;
      continue;
    }
    if (isIdentStart(code)) {
      let stop = at + 1;
      while (stop < end && isIdentPart(text.charCodeAt(stop))) stop += 1;
      yield { kind: 'ident', text: text.slice(at, stop) };
      at = stop;
      continue;
    }
    yield { kind: 'punct', text: text[at]! };
    at += 1;
  }
}

/**
 * The targets of `import "…";`, `import public "…";` and `import weak "…";` in `text`, in order,
 * exactly as written between the quotes.
 */
export function protoImportsOf(text: string): string[] {
  const found: string[] = [];
  // Where in an import statement the scan stands: not in one, after `import`, after
  // `public`/`weak`, or after the target (waiting for `;`).
  let state: 'start' | 'other' | 'import' | 'modifier' | 'target' = 'start';
  let target = '';
  for (const token of tokens(text)) {
    switch (state) {
      case 'import':
        if (token.kind === 'ident' && (token.text === 'public' || token.text === 'weak')) {
          state = 'modifier';
          continue;
        }
      // falls through: `import "x"` has no modifier
      case 'modifier':
        if (token.kind === 'string') {
          target = token.text;
          state = 'target';
          continue;
        }
        break;
      case 'target':
        if (token.kind === 'punct' && token.text === ';') {
          if (target !== '') found.push(target);
          state = 'start';
          continue;
        }
        break;
      case 'start':
        if (token.kind === 'ident' && token.text === 'import') {
          state = 'import';
          continue;
        }
        break;
      case 'other':
        break;
    }
    // Any other token: a statement starts after `;`, `{` or `}`, and nowhere else.
    state =
      token.kind === 'punct' && (token.text === ';' || token.text === '{' || token.text === '}') ? 'start' : 'other';
  }
  return found;
}
