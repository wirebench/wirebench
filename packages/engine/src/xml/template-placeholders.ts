/**
 * The sample generator writes `?` into every value it cannot know (`<tem:intA>?</tem:intA>`). A
 * request still holding one goes out with a literal "?", which a real service answers with a schema
 * fault, so Validate flags them, a send asks first and the Runner reports them (#728).
 *
 * Pure text scanning, safe in the renderer: an element whose whole text is `?`, or an attribute
 * whose value is `?`. Comments and CDATA sections are skipped.
 */

/** One value still holding the template `?`. */
export interface TemplatePlaceholder {
  /** The element's qualified name, or `@name` for an attribute. */
  readonly name: string;
  /** 1-based line of the `?`. */
  readonly line: number;
  /** 1-based column of the `?`. */
  readonly column: number;
}

/** The template value the sample generator writes. */
export const TEMPLATE_PLACEHOLDER = '?';

/**
 * `xml` with every comment and CDATA section blanked to spaces (newlines kept, so offsets stay where
 * they were). A linear `indexOf` scan, not a lazy regex: on many unclosed `<!--` a regex backtracks.
 */
function blankSkipped(xml: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const comment = xml.indexOf('<!--', at);
    const cdata = xml.indexOf('<![CDATA[', at);
    const start = comment === -1 ? cdata : cdata === -1 ? comment : Math.min(comment, cdata);
    if (start === -1) break;
    const close = start === comment ? '-->' : ']]>';
    const end = xml.indexOf(close, start + (start === comment ? 4 : 9));
    const stop = end === -1 ? xml.length : end + close.length;
    out += xml.slice(at, start) + xml.slice(start, stop).replace(/[^\n]/g, ' ');
    at = stop;
  }
  return out + xml.slice(at);
}

const ELEMENT = />(\s*)\?\s*<\/([A-Za-z_][\w.:-]*)\s*>/g;
const ATTRIBUTE = /\s([A-Za-z_][\w.:-]*)\s*=\s*(["'])\?\2/g;

/** Every template `?` in `xml`, in document order. */
export function findTemplatePlaceholders(xml: string): TemplatePlaceholder[] {
  // Blank out what is skipped, keeping offsets (and so lines and columns) where they were.
  const text = blankSkipped(xml);
  const found: { readonly name: string; readonly offset: number }[] = [];
  for (const match of text.matchAll(ELEMENT)) {
    found.push({ name: match[2] ?? '', offset: match.index + 1 + (match[1]?.length ?? 0) });
  }
  for (const match of text.matchAll(ATTRIBUTE)) {
    // Only inside a tag: the attribute pattern alone would match `a="?"` in text content too.
    const before = text.lastIndexOf('<', match.index);
    if (before === -1 || text.lastIndexOf('>', match.index) > before) continue;
    found.push({ name: `@${match[1] ?? ''}`, offset: match.index + match[0].length - 2 });
  }
  found.sort((a, b) => a.offset - b.offset);

  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') lineStarts.push(index + 1);
  }
  return found.map(({ name, offset }) => {
    let line = 0;
    while (line + 1 < lineStarts.length && (lineStarts[line + 1] ?? Infinity) <= offset) line += 1;
    return { name, line: line + 1, column: offset - (lineStarts[line] ?? 0) + 1 };
  });
}
