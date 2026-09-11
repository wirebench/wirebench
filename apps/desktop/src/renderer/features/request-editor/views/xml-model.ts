/**
 * Text <-> tree model for the Outline view (Task 26). Pure and renderer-safe: no DOM parser,
 * no `@xmldom/xmldom` — a tolerant hand-rolled tokenizer walks the raw envelope text once,
 * building an element tree whose every node and attribute carries the exact UTF-16 offset
 * range (Monaco convention) it came from. `applyValueEdit` is the only way the outline writes
 * back: it replaces one such range with an escaped value and returns the whole new document,
 * so the request pane can commit it through the very same path as a keystroke.
 *
 * Deliberately never adds or removes nodes — the Outline editor only ever edits values in
 * place, and this module has no API surface for anything else.
 */

/** A half-open UTF-16 character range in a text document (Monaco convention). */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

/** One attribute on an outline element, with the value's range inside (not including) its quotes. */
export interface OutlineAttr {
  readonly name: string;
  readonly value: string;
  readonly valueRange: TextRange;
}

/** One element in the parsed outline tree. */
export interface OutlineNode {
  /** Stable, path-based id: the chain of child indices from the document root, e.g. `'0/2/1'`. */
  readonly id: string;
  readonly kind: 'element';
  /** As written in the source, including any prefix (e.g. `'tem:Add'`). */
  readonly name: string;
  readonly localName: string;
  readonly prefix?: string;
  /** Resolved from the `xmlns`/`xmlns:*` declarations in scope; absent when unresolvable. */
  readonly namespaceUri?: string;
  /** The whole element, open tag through close tag (or through `/>` when self-closing). */
  readonly range: TextRange;
  readonly nameRange: TextRange;
  readonly attributes: readonly OutlineAttr[];
  /** Present only when this element's content is text-only (including empty) — never alongside `children`. */
  readonly text?: { readonly value: string; readonly range: TextRange };
  readonly children: readonly OutlineNode[];
  readonly selfClosing: boolean;
  /** Count of `<!-- -->` comments found directly inside this element, if any. */
  readonly comments?: number;
}

/** Result of {@link parseXmlOutline}: the root element (if any could be found) plus tolerance notes. */
export interface ParseXmlOutlineResult {
  readonly root?: OutlineNode;
  readonly problems: readonly string[];
}

const XML_PREFIX = 'xml';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const NAME_CHAR_RE = /[^\s/>]/;

/** Decodes the five predefined XML entities plus numeric character references. */
function decodeEntities(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body === 'amp') return '&';
    if (body === 'lt') return '<';
    if (body === 'gt') return '>';
    if (body === 'quot') return '"';
    if (body === 'apos') return "'";
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return match;
  });
}

/** Escapes text content: `&` and `<` are the only characters that must never appear literally. */
export function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/** Escapes an attribute value for the given quote character (defaults to `"`). */
export function escapeXmlAttr(value: string, quote: '"' | "'" = '"'): string {
  const base = value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return quote === '"' ? base.replace(/"/g, '&quot;') : base.replace(/'/g, '&apos;');
}

/**
 * Escapes `newValue` exactly as {@link applyValueEdit} would write it into `range`, without
 * performing the splice. The character just before `range.start` tells the two contexts apart:
 * a quote mark means `range` sits inside an attribute value (so that quote character is escaped
 * too), anything else means it is element text content (only `&`/`<` need escaping).
 *
 * Callers that need to predict the length delta of a pending edit (e.g. to shift later ranges
 * before the edit is committed) must use this — not a hand-rolled escape — so the delta always
 * matches what `applyValueEdit` actually writes.
 */
export function escapeForRange(text: string, range: TextRange, newValue: string): string {
  const quoteChar = text[range.start - 1];
  return quoteChar === '"' || quoteChar === "'" ? escapeXmlAttr(newValue, quoteChar) : escapeXmlText(newValue);
}

/**
 * Replaces exactly `range` in `text` with `newValue`, escaped for its context. See
 * {@link escapeForRange} for how the context is determined.
 */
export function applyValueEdit(text: string, range: TextRange, newValue: string): string {
  const before = text.slice(0, range.start);
  const after = text.slice(range.end);
  const escaped = escapeForRange(text, range, newValue);
  return before + escaped + after;
}

interface NameParts {
  readonly localName: string;
  readonly prefix?: string;
}

function splitName(name: string): NameParts {
  const colon = name.indexOf(':');
  if (colon === -1) {
    return { localName: name };
  }
  return { prefix: name.slice(0, colon), localName: name.slice(colon + 1) };
}

/** Mutable working copy of {@link OutlineNode} used while building the tree. */
interface Draft {
  id: string;
  name: string;
  localName: string;
  prefix?: string;
  namespaceUri?: string;
  range: TextRange;
  nameRange: TextRange;
  attributes: OutlineAttr[];
  text?: { value: string; range: TextRange };
  children: Draft[];
  selfClosing: boolean;
  comments?: number;
}

interface ContentSpan {
  readonly kind: 'text' | 'cdata';
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

interface Frame {
  readonly draft: Draft;
  readonly prefixes: Readonly<Record<string, string>>;
  sawChildElement: boolean;
  childCount: number;
  readonly spans: ContentSpan[];
}

function toOutlineNode(draft: Draft): OutlineNode {
  return {
    id: draft.id,
    kind: 'element',
    name: draft.name,
    localName: draft.localName,
    ...(draft.prefix !== undefined ? { prefix: draft.prefix } : {}),
    ...(draft.namespaceUri !== undefined ? { namespaceUri: draft.namespaceUri } : {}),
    range: draft.range,
    nameRange: draft.nameRange,
    attributes: draft.attributes,
    ...(draft.text !== undefined ? { text: draft.text } : {}),
    children: draft.children.map(toOutlineNode),
    selfClosing: draft.selfClosing,
    ...(draft.comments !== undefined ? { comments: draft.comments } : {}),
  };
}

type ParsedAttr = OutlineAttr;

/** Parses `name="value"`/`name='value'` pairs out of `text.slice(start, end)`, offsets kept absolute. */
function parseAttrs(text: string, start: number, end: number): ParsedAttr[] {
  const region = text.slice(start, end);
  const out: ParsedAttr[] = [];
  const re = new RegExp(ATTR_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(region)) !== null) {
    const name = m[1] as string;
    const dq = m[2];
    const sq = m[3];
    const raw = dq ?? sq ?? '';
    const quoteChar = dq !== undefined ? '"' : "'";
    const matchStart = start + m.index;
    const eqIdx = m[0].indexOf('=');
    const quoteIdx = m[0].indexOf(quoteChar, eqIdx === -1 ? 0 : eqIdx);
    const valueStart = quoteIdx === -1 ? matchStart : matchStart + quoteIdx + 1;
    const valueEnd = valueStart + raw.length;
    out.push({ name, value: decodeEntities(raw), valueRange: { start: valueStart, end: valueEnd } });
  }
  return out;
}

interface OpenTagInfo {
  readonly tagEnd: number;
  readonly selfClosing: boolean;
  readonly name: string;
  readonly nameRange: TextRange;
  readonly attrs: ParsedAttr[];
}

/** Scans one open (or self-closing) tag starting at `text[lt] === '<'`, respecting quoted attribute values. */
function parseOpenTag(text: string, lt: number): OpenTagInfo | undefined {
  let i = lt + 1;
  const nameStart = i;
  while (i < text.length && NAME_CHAR_RE.test(text[i] as string)) {
    i += 1;
  }
  if (i === nameStart) {
    return undefined;
  }
  const name = text.slice(nameStart, i);
  const nameRange: TextRange = { start: nameStart, end: i };

  let quote: string | undefined;
  while (i < text.length) {
    const ch = text[i];
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined;
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '>') {
      break;
    }
    i += 1;
  }
  if (i >= text.length) {
    return undefined;
  }
  const tagEnd = i;
  const selfClosing = text[tagEnd - 1] === '/';
  const attrsEnd = selfClosing ? tagEnd - 1 : tagEnd;
  const attrs = parseAttrs(text, nameStart + name.length, attrsEnd);
  return { tagEnd, selfClosing, name, nameRange, attrs };
}

/** Merges any `xmlns`/`xmlns:*` declarations on `attrs` into `parent`, without mutating it. */
function computeNamespaces(attrs: readonly OutlineAttr[], parent: Readonly<Record<string, string>>) {
  let decls: Record<string, string> | undefined;
  for (const attr of attrs) {
    if (attr.name === 'xmlns') {
      decls = { ...(decls ?? parent), '': attr.value };
    } else if (attr.name.startsWith('xmlns:')) {
      decls = { ...(decls ?? parent), [attr.name.slice('xmlns:'.length)]: attr.value };
    }
  }
  return decls ?? parent;
}

function resolveNamespace(prefix: string | undefined, prefixes: Readonly<Record<string, string>>): string | undefined {
  if (prefix === XML_PREFIX) {
    return XML_NS;
  }
  const found = prefixes[prefix ?? ''];
  if (found !== undefined) {
    return found;
  }
  return prefix === undefined ? '' : undefined;
}

/** Builds a text-only element's `text` field from its recorded content spans, or leaves it unset. */
function finalizeText(frame: Frame, contentStart: number): void {
  if (frame.sawChildElement) {
    return;
  }
  if (frame.spans.length === 0) {
    frame.draft.text = { value: '', range: { start: contentStart, end: contentStart } };
    return;
  }
  const first = frame.spans[0] as ContentSpan;
  const last = frame.spans[frame.spans.length - 1] as ContentSpan;
  frame.draft.text = {
    value: frame.spans.map((span) => span.value).join(''),
    range: { start: first.start, end: last.end },
  };
}

/**
 * Parses `text` into an {@link OutlineNode} tree with exact ranges. Tolerant of malformed
 * input — unterminated tags/comments/CDATA stop the scan and record a problem rather than
 * throwing, and any elements still open at end-of-input are closed at the document end so the
 * caller gets a best-effort tree either way.
 */
export function parseXmlOutline(text: string): ParseXmlOutlineResult {
  const problems: string[] = [];
  const len = text.length;
  let i = 0;
  const stack: Frame[] = [];
  let root: Draft | undefined;
  let topLevelCount = 0;

  const currentFrame = (): Frame | undefined => stack[stack.length - 1];

  while (i < len) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      break;
    }
    if (lt > i) {
      const frame = currentFrame();
      if (frame !== undefined) {
        const raw = text.slice(i, lt);
        frame.spans.push({ kind: 'text', start: i, end: lt, value: decodeEntities(raw) });
      }
    }

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) {
        problems.push(`Unterminated comment at offset ${lt}`);
        break;
      }
      const frame = currentFrame();
      if (frame !== undefined) {
        frame.draft.comments = (frame.draft.comments ?? 0) + 1;
      }
      i = end + 3;
      continue;
    }

    if (text.startsWith('<![CDATA[', lt)) {
      const payloadStart = lt + 9;
      const end = text.indexOf(']]>', payloadStart);
      if (end === -1) {
        problems.push(`Unterminated CDATA section at offset ${lt}`);
        break;
      }
      const frame = currentFrame();
      if (frame !== undefined) {
        frame.spans.push({
          kind: 'cdata',
          start: payloadStart,
          end,
          value: text.slice(payloadStart, end),
        });
      }
      i = end + 3;
      continue;
    }

    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end === -1) {
        problems.push(`Unterminated processing instruction at offset ${lt}`);
        break;
      }
      i = end + 2;
      continue;
    }

    if (text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt + 2);
      if (end === -1) {
        problems.push(`Unterminated declaration at offset ${lt}`);
        break;
      }
      i = end + 1;
      continue;
    }

    if (text.startsWith('</', lt)) {
      const end = text.indexOf('>', lt + 2);
      if (end === -1) {
        problems.push(`Unterminated closing tag at offset ${lt}`);
        break;
      }
      const frame = stack.pop();
      if (frame === undefined) {
        problems.push(`Unexpected closing tag at offset ${lt} with no open element`);
      } else {
        finalizeText(frame, frame.draft.range.end);
        frame.draft.range = { start: frame.draft.range.start, end: end + 1 };
        const parent = currentFrame();
        if (parent !== undefined) {
          parent.sawChildElement = true;
        }
      }
      i = end + 1;
      continue;
    }

    const parsed = parseOpenTag(text, lt);
    if (parsed === undefined) {
      problems.push(`Malformed tag at offset ${lt}`);
      i = lt + 1;
      continue;
    }
    const { tagEnd, selfClosing, name, nameRange, attrs } = parsed;
    const parentFrame = currentFrame();
    const parentPrefixes = parentFrame?.prefixes ?? {};
    const prefixes = computeNamespaces(attrs, parentPrefixes);
    const { localName, prefix } = splitName(name);
    const namespaceUri = resolveNamespace(prefix, prefixes);
    const id = parentFrame === undefined ? String(topLevelCount) : `${parentFrame.draft.id}/${parentFrame.childCount}`;

    const draft: Draft = {
      id,
      name,
      localName,
      ...(prefix !== undefined ? { prefix } : {}),
      ...(namespaceUri !== undefined ? { namespaceUri } : {}),
      range: { start: lt, end: tagEnd + 1 },
      nameRange,
      attributes: attrs,
      children: [],
      selfClosing,
    };

    if (parentFrame === undefined) {
      if (root === undefined) {
        root = draft;
      }
      topLevelCount += 1;
    } else {
      parentFrame.draft.children.push(draft);
      parentFrame.sawChildElement = true;
      parentFrame.childCount += 1;
    }

    if (!selfClosing) {
      stack.push({ draft, prefixes, sawChildElement: false, childCount: 0, spans: [] });
    } else {
      finalizeText({ draft, prefixes, sawChildElement: false, childCount: 0, spans: [] }, tagEnd + 1);
    }

    i = tagEnd + 1;
  }

  if (stack.length > 0) {
    problems.push('Document ended with unclosed element(s); closed at end of text');
    while (stack.length > 0) {
      const frame = stack.pop() as Frame;
      finalizeText(frame, frame.draft.range.end);
      frame.draft.range = { start: frame.draft.range.start, end: len };
    }
  }

  return { ...(root !== undefined ? { root: toOutlineNode(root) } : {}), problems };
}
