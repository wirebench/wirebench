/**
 * Indents HTML by tag depth, for reading a response.
 *
 * Deliberately not a parser: HTML's void elements, optional end tags and inline content make a
 * faithful formatter a project of its own, and this only has to make a response readable. Block
 * tags go on a line of their own; text and inline elements (`b`, `a`, `span`, `title`…) stay together
 * on one line under the tag that opened them, so `<p>a <b>pet</b> store</p>` reads as a sentence. The
 * content of `script`, `style`, `pre` and `textarea` is kept exactly as it came, end tag included: a
 * `<` in a script is not a tag, and a `pre` means its spacing.
 *
 * Pure and browser-safe, so the renderer's Pretty view formats exactly as the engine does.
 */

/** Elements that never have an end tag. */
const VOID_TAG = /^<(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b/i;
/** Elements whose content is text, not markup. */
const RAW_TEXT_TAG = /^<(script|style|pre|textarea)\b/i;
/**
 * Elements that sit inside a line of text rather than starting one. `title` and `option` are not
 * inline in HTML's sense, but hold only text, which reads best on the tag's own line.
 */
const INLINE_TAG =
  /^<\/?(?:a|abbr|b|bdi|bdo|br|button|cite|code|data|dfn|em|i|img|kbd|label|mark|option|q|s|samp|small|span|strong|sub|sup|time|title|u|var|wbr)(?=[\s/>])/i;
/** A comment (which may hold a `>`) or any other tag. */
const TAG = /<!--[\s\S]*?-->|<[^>]*>/g;

/** `text` with one block tag or line of inline content per line, indented `indent` spaces per level. */
export function formatHtml(text: string, indent = 2): string {
  const source = text.replace(/\r\n?/g, '\n');
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  let depth = 0;
  let at = 0;
  // Text and inline tags since the last block tag, written out as one line when a block tag ends it.
  let inline = '';
  const flush = (): void => {
    const trimmed = inline.replace(/\s+/g, ' ').trim();
    if (trimmed !== '') {
      lines.push(pad.repeat(depth) + trimmed);
    }
    inline = '';
  };

  const tag = new RegExp(TAG.source, 'g');
  for (let match = tag.exec(source); match !== null; match = tag.exec(source)) {
    inline += source.slice(at, match.index);
    const token = match[0];
    at = tag.lastIndex;
    if (INLINE_TAG.test(token)) {
      inline += token;
      continue;
    }
    flush();
    if (token.startsWith('</')) {
      depth = Math.max(0, depth - 1);
      lines.push(pad.repeat(depth) + token);
      continue;
    }
    if (token.startsWith('<!') || token.startsWith('<?') || token.endsWith('/>') || VOID_TAG.test(token)) {
      lines.push(pad.repeat(depth) + token);
      continue;
    }
    const raw = RAW_TEXT_TAG.exec(token);
    if (raw !== null) {
      // Everything up to the end tag goes out as it came, on the open tag's line: re-indenting it
      // would change a pre's text and could change what a script or style means.
      const close = new RegExp(`</${raw[1] ?? ''}\\s*>`, 'i').exec(source.slice(at));
      const end = close === null ? source.length : at + close.index + close[0].length;
      lines.push(pad.repeat(depth) + token + source.slice(at, end));
      at = end;
      tag.lastIndex = at;
      continue;
    }
    lines.push(pad.repeat(depth) + token);
    depth += 1;
  }
  inline += source.slice(at);
  flush();
  return lines.join('\n');
}
