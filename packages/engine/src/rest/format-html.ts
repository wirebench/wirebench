/**
 * Indents HTML by tag depth, for reading a response.
 *
 * Deliberately not a parser: HTML's void elements, optional end tags and inline content make a
 * faithful formatter a project of its own, and this only has to make a response readable. Text runs
 * go on a line of their own under the tag that opened them. The content of `script`, `style`, `pre`
 * and `textarea` is kept as it came: a `<` in a script is not a tag, and a `pre` means its spacing.
 *
 * Pure and browser-safe, so the renderer's Pretty view formats exactly as the engine does.
 */

/** Elements that never have an end tag. */
const VOID_TAG = /^<(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b/i;
/** Elements whose content is text, not markup. */
const RAW_TEXT_TAG = /^<(script|style|pre|textarea)\b/i;
/** A comment (which may hold a `>`) or any other tag. */
const TAG = /<!--[\s\S]*?-->|<[^>]*>/g;

/** `text` with one tag or text run per line, indented `indent` spaces per level. */
export function formatHtml(text: string, indent = 2): string {
  const source = text.replace(/\r\n?/g, '\n');
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  let depth = 0;
  let at = 0;
  const pushText = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed !== '') {
      lines.push(pad.repeat(depth) + trimmed);
    }
  };

  const tag = new RegExp(TAG.source, 'g');
  for (let match = tag.exec(source); match !== null; match = tag.exec(source)) {
    pushText(source.slice(at, match.index));
    const token = match[0];
    at = tag.lastIndex;
    if (token.startsWith('</')) {
      depth = Math.max(0, depth - 1);
      lines.push(pad.repeat(depth) + token);
      continue;
    }
    lines.push(pad.repeat(depth) + token);
    if (token.startsWith('<!') || token.startsWith('<?') || token.endsWith('/>') || VOID_TAG.test(token)) {
      continue;
    }
    const raw = RAW_TEXT_TAG.exec(token);
    if (raw !== null) {
      const close = new RegExp(`</${raw[1] ?? ''}\\s*>`, 'i').exec(source.slice(at));
      const end = close === null ? source.length : at + close.index;
      const inner = source.slice(at, end).replace(/^\n+|\n+$/g, '');
      if (inner.trim() !== '') {
        lines.push(inner);
      }
      if (close !== null) {
        lines.push(pad.repeat(depth) + close[0]);
      }
      at = close === null ? source.length : end + close[0].length;
      tag.lastIndex = at;
      continue;
    }
    depth += 1;
  }
  pushText(source.slice(at));
  return lines.join('\n');
}
