/**
 * A tolerant, dependency-free XML fragment scanner used by the form model.
 *
 * It walks the raw text once and produces an element tree in which every node,
 * attribute value and text run carries the exact UTF-16 offset range it came
 * from, so the form view can splice a single value back into the envelope
 * without reformatting anything around it. Never throws: malformed input stops
 * the scan and is reported, and elements still open at end-of-input are closed
 * at the document end.
 *
 * Deliberately minimal — it exists to read a body fragment, not to validate
 * one, so entities are decoded but DTDs, namespaces beyond `xmlns` bookkeeping
 * and processing instructions are skipped.
 */

/** A half-open UTF-16 character range in a text document. */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

/** One attribute, with the range of its value inside (not including) the quotes. */
export interface ScannedAttribute {
  /** As written, including any prefix (e.g. `xsi:type`). */
  readonly name: string;
  readonly value: string;
  readonly valueRange: TextRange;
}

/** One scanned element. */
export interface ScannedElement {
  /** As written, including any prefix (e.g. `tem:Add`). */
  readonly name: string;
  readonly localName: string;
  readonly prefix?: string;
  /** Resolved from the `xmlns`/`xmlns:*` declarations in scope; `''` when in no namespace. */
  readonly namespaceUri: string;
  /** Prefix → URI declared *on this element*, empty when it declares none. */
  readonly declaredNamespaces: Readonly<Record<string, string>>;
  readonly attributes: readonly ScannedAttribute[];
  /** The whole element, `<` through the end of its close tag (or `/>`). */
  readonly range: TextRange;
  /** Text content and its range — only for a non-self-closing element with no child elements. */
  readonly text?: { readonly value: string; readonly range: TextRange };
  readonly children: readonly ScannedElement[];
  readonly selfClosing: boolean;
  /** Comments found directly before this element inside its parent, in source order. */
  readonly leadingComments: readonly string[];
  /** Comments found inside this element after its last child element. */
  readonly trailingComments: readonly string[];
}

/** What {@link scanXml} returns: the top-level elements plus any tolerance notes. */
export interface ScanXmlResult {
  readonly elements: readonly ScannedElement[];
  readonly problems: readonly string[];
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const NAME_CHAR_RE = /[^\s/>]/;
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

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

interface Draft {
  name: string;
  localName: string;
  prefix?: string;
  namespaceUri: string;
  declaredNamespaces: Record<string, string>;
  attributes: ScannedAttribute[];
  range: TextRange;
  text?: { value: string; range: TextRange };
  children: Draft[];
  selfClosing: boolean;
  leadingComments: string[];
  trailingComments: string[];
}

interface Frame {
  readonly draft: Draft;
  readonly prefixes: Readonly<Record<string, string>>;
  sawChildElement: boolean;
  readonly spans: { start: number; end: number; value: string }[];
  /** Comments seen since the last child element, waiting for the next one to lead. */
  pendingComments: string[];
}

function toElement(draft: Draft): ScannedElement {
  return {
    name: draft.name,
    localName: draft.localName,
    ...(draft.prefix !== undefined ? { prefix: draft.prefix } : {}),
    namespaceUri: draft.namespaceUri,
    declaredNamespaces: draft.declaredNamespaces,
    attributes: draft.attributes,
    range: draft.range,
    ...(draft.text !== undefined ? { text: draft.text } : {}),
    children: draft.children.map(toElement),
    selfClosing: draft.selfClosing,
    leadingComments: draft.leadingComments,
    trailingComments: draft.trailingComments,
  };
}

/** Parses `name="value"` pairs out of `text.slice(start, end)`, keeping offsets absolute. */
function parseAttrs(text: string, start: number, end: number): ScannedAttribute[] {
  const region = text.slice(start, end);
  const out: ScannedAttribute[] = [];
  const re = new RegExp(ATTR_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(region)) !== null) {
    const name = m[1] as string;
    const dq = m[2];
    const raw = dq ?? m[3] ?? '';
    const quoteChar = dq !== undefined ? '"' : "'";
    const matchStart = start + m.index;
    const eqIdx = m[0].indexOf('=');
    const quoteIdx = m[0].indexOf(quoteChar, eqIdx === -1 ? 0 : eqIdx);
    const valueStart = quoteIdx === -1 ? matchStart : matchStart + quoteIdx + 1;
    out.push({
      name,
      value: decodeEntities(raw),
      valueRange: { start: valueStart, end: valueStart + raw.length },
    });
  }
  return out;
}

interface OpenTag {
  readonly tagEnd: number;
  readonly selfClosing: boolean;
  readonly name: string;
  readonly attrs: ScannedAttribute[];
}

/** Scans one open (or self-closing) tag starting at `text[lt] === '<'`, respecting quoted values. */
function parseOpenTag(text: string, lt: number): OpenTag | undefined {
  let i = lt + 1;
  const nameStart = i;
  while (i < text.length && NAME_CHAR_RE.test(text[i] as string)) {
    i += 1;
  }
  if (i === nameStart) {
    return undefined;
  }
  const name = text.slice(nameStart, i);
  let quote: string | undefined;
  while (i < text.length) {
    const ch = text[i];
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      break;
    }
    i += 1;
  }
  if (i >= text.length) {
    return undefined;
  }
  const selfClosing = text[i - 1] === '/';
  return {
    tagEnd: i,
    selfClosing,
    name,
    attrs: parseAttrs(text, nameStart + name.length, selfClosing ? i - 1 : i),
  };
}

function splitName(name: string): { localName: string; prefix?: string } {
  const colon = name.indexOf(':');
  return colon === -1 ? { localName: name } : { prefix: name.slice(0, colon), localName: name.slice(colon + 1) };
}

/** Merges any `xmlns`/`xmlns:*` declarations on `attrs` into `parent`, without mutating it. */
function declarationsOf(attrs: readonly ScannedAttribute[]): Record<string, string> {
  const decls: Record<string, string> = {};
  for (const attr of attrs) {
    if (attr.name === 'xmlns') {
      decls[''] = attr.value;
    } else if (attr.name.startsWith('xmlns:')) {
      decls[attr.name.slice('xmlns:'.length)] = attr.value;
    }
  }
  return decls;
}

/** Records a text-only element's content span, or an empty one when it has none. */
function finalizeText(frame: Frame, contentStart: number): void {
  if (frame.sawChildElement) {
    return;
  }
  if (frame.spans.length === 0) {
    frame.draft.text = { value: '', range: { start: contentStart, end: contentStart } };
    return;
  }
  const first = frame.spans[0] as { start: number };
  const last = frame.spans[frame.spans.length - 1] as { end: number };
  frame.draft.text = {
    value: frame.spans.map((s) => s.value).join(''),
    range: { start: first.start, end: last.end },
  };
}

/**
 * Scans an XML fragment into an element tree with exact ranges.
 *
 * @param text the raw fragment; may contain several top-level elements
 * @param inScope prefix → URI bindings inherited from an enclosing document (a
 *   body fragment sliced out of an envelope carries none of its own)
 */
export function scanXml(text: string, inScope: Readonly<Record<string, string>> = {}): ScanXmlResult {
  const problems: string[] = [];
  const len = text.length;
  const stack: Frame[] = [];
  const roots: Draft[] = [];
  let rootComments: string[] = [];
  let i = 0;

  const frame = (): Frame | undefined => stack[stack.length - 1];

  while (i < len) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      break;
    }
    if (lt > i) {
      const current = frame();
      if (current !== undefined) {
        current.spans.push({ start: i, end: lt, value: decodeEntities(text.slice(i, lt)) });
      }
    }

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) {
        problems.push(`Unterminated comment at offset ${lt}`);
        break;
      }
      const body = text.slice(lt + 4, end);
      const current = frame();
      if (current === undefined) {
        rootComments.push(body);
      } else {
        current.pendingComments.push(body);
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
      frame()?.spans.push({ start: payloadStart, end, value: text.slice(payloadStart, end) });
      i = end + 3;
      continue;
    }

    if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) {
      const closer = text.startsWith('<?', lt) ? '?>' : '>';
      const end = text.indexOf(closer, lt + 2);
      if (end === -1) {
        problems.push(`Unterminated declaration at offset ${lt}`);
        break;
      }
      i = end + closer.length;
      continue;
    }

    if (text.startsWith('</', lt)) {
      const end = text.indexOf('>', lt + 2);
      if (end === -1) {
        problems.push(`Unterminated closing tag at offset ${lt}`);
        break;
      }
      const closing = stack.pop();
      if (closing === undefined) {
        problems.push(`Unexpected closing tag at offset ${lt} with no open element`);
      } else {
        finalizeText(closing, closing.draft.range.end);
        closing.draft.trailingComments = closing.pendingComments;
        closing.draft.range = { start: closing.draft.range.start, end: end + 1 };
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
    const parent = frame();
    const declared = declarationsOf(parsed.attrs);
    const prefixes =
      Object.keys(declared).length > 0
        ? { ...(parent?.prefixes ?? inScope), ...declared }
        : (parent?.prefixes ?? inScope);
    const { localName, prefix } = splitName(parsed.name);
    const namespaceUri = prefix === 'xml' ? XML_NS : (prefixes[prefix ?? ''] ?? '');
    const leading = parent === undefined ? rootComments : parent.pendingComments;
    const draft: Draft = {
      name: parsed.name,
      localName,
      ...(prefix !== undefined ? { prefix } : {}),
      namespaceUri,
      declaredNamespaces: declared,
      attributes: parsed.attrs,
      range: { start: lt, end: parsed.tagEnd + 1 },
      children: [],
      selfClosing: parsed.selfClosing,
      leadingComments: leading,
      trailingComments: [],
    };
    if (parent === undefined) {
      roots.push(draft);
      rootComments = [];
    } else {
      parent.draft.children.push(draft);
      parent.sawChildElement = true;
      parent.pendingComments = [];
    }

    // A self-closing element has no content range at all, so it never gets a
    // `text` field — a value edit on it must go through a structural edit.
    if (!parsed.selfClosing) {
      stack.push({ draft, prefixes, sawChildElement: false, spans: [], pendingComments: [] });
    }
    i = parsed.tagEnd + 1;
  }

  if (stack.length > 0) {
    problems.push('Fragment ended with unclosed element(s); closed at end of text');
    while (stack.length > 0) {
      const open = stack.pop() as Frame;
      finalizeText(open, open.draft.range.end);
      open.draft.range = { start: open.draft.range.start, end: len };
    }
  }

  return { elements: roots.map(toElement), problems };
}
