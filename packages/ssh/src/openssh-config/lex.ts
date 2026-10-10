import type { SshConfigLine, SshConfigProblem } from './types.js';

/** Splits one line into words: whitespace or a single `=` separates; `"…"` keeps spaces; `#` after a gap ends it. */
function words(text: string): string[] | undefined {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i] as string)) i += 1;
    // The keyword may be followed by `=`, with or without spaces around it.
    if (out.length === 1 && text[i] === '=') {
      i += 1;
      while (i < text.length && /\s/.test(text[i] as string)) i += 1;
    }
    if (i >= text.length || text[i] === '#') break;
    let word = '';
    while (i < text.length && !/\s/.test(text[i] as string)) {
      const ch = text[i] as string;
      if (ch === '"') {
        const close = text.indexOf('"', i + 1);
        if (close === -1) return undefined;
        word += text.slice(i + 1, close);
        i = close + 1;
      } else if (out.length === 0 && ch === '=') {
        break; // `Keyword=value`
      } else {
        word += ch;
        i += 1;
      }
    }
    out.push(word);
  }
  return out;
}

/** Lexes `ssh_config(5)` text. Lines that do not lex are reported by number, never quoted. */
export function lexSshConfig(text: string, file: string): { lines: SshConfigLine[]; problems: SshConfigProblem[] } {
  const lines: SshConfigLine[] = [];
  const problems: SshConfigProblem[] = [];
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  source.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const parts = words(raw);
    if (parts === undefined) {
      problems.push({ file, line, why: 'line could not be read' });
      return;
    }
    const [keyword, ...args] = parts;
    if (keyword === undefined || keyword === '') return;
    if (args.length === 0) {
      problems.push({ file, line, why: 'keyword without a value' });
      return;
    }
    lines.push({ file, line, keyword: keyword.toLowerCase(), args });
  });
  return { lines, problems };
}
