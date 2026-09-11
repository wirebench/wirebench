/**
 * Pulls the source XML of a schema component out of the document text the Schema tab already
 * has. Purely textual — the renderer has no parser and no fs — and deliberately tolerant: a
 * declaration whose end cannot be found falls back to the single line it starts on.
 */

/** Byte offset of the start of 1-based `line` in `text`. */
function offsetOfLine(text: string, line: number): number {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const next = text.indexOf('\n', offset);
    if (next === -1) {
      return offset;
    }
    offset = next + 1;
  }
  return offset;
}

/** Removes the common leading indentation of every non-empty line. */
function dedent(snippet: string): string {
  const lines = snippet.split('\n');
  const indents = lines.filter((line) => line.trim().length > 0).map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0);
  const common = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => line.slice(common)).join('\n');
}

/**
 * The XML of the element declared at `line` (1-based) in `text`, capped at `maxLines` lines.
 * Nested elements of the same name are counted, so `<xs:element>` wrapping another one still
 * ends on the right closing tag.
 */
export function sourceSnippet(text: string, line: number | undefined, maxLines = 40): string {
  if (line === undefined || line < 1) {
    return '';
  }
  const start = offsetOfLine(text, line);
  const rest = text.slice(start);
  const open = /^\s*<([^\s/>]+)/.exec(rest);
  if (open === null) {
    return dedent(rest.split('\n')[0] ?? '').trimEnd();
  }
  const name = open[1] as string;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tagRe = new RegExp(`<${escaped}(?=[\\s/>])[^>]*?(/?)>|</${escaped}\\s*>`, 'g');
  let depth = 0;
  let end = -1;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(rest)) !== null) {
    if (match[0].startsWith('</')) {
      depth -= 1;
    } else if (match[1] === '/') {
      // A self-closing tag opens and closes at once.
      if (depth === 0) {
        end = match.index + match[0].length;
        break;
      }
      continue;
    } else {
      depth += 1;
    }
    if (depth === 0) {
      end = match.index + match[0].length;
      break;
    }
  }
  const slice = end === -1 ? (rest.split('\n')[0] ?? '') : rest.slice(0, end);
  const lines = dedent(slice).split('\n');
  return lines.length > maxLines ? `${lines.slice(0, maxLines).join('\n')}\n…` : lines.join('\n');
}
