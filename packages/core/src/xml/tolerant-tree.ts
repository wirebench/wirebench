/**
 * A tolerant XML tokenizer shared by the pretty printer and the envelope transforms.
 *
 * "Tolerant" means: it never throws, it recognises every construct a serializer would
 * normally lose (comments, CDATA, processing instructions, the XML declaration, DOCTYPE),
 * and it reports failure by returning `undefined` rather than by raising — the callers are
 * text transforms that must return their input unchanged when they cannot understand it.
 *
 * Every token carries its `[start, end)` offsets into the original text, so a transform can
 * splice ranges out of the source instead of re-serializing a tree (which would silently
 * rewrite attribute spacing and quoting).
 */

/** What a {@link XmlToken} is. */
export type XmlTokenKind = 'comment' | 'cdata' | 'pi' | 'doctype' | 'open' | 'close' | 'text';

/** One lexical unit of an XML document, with its offsets into the source text. */
export interface XmlToken {
  readonly kind: XmlTokenKind;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
  /** Element name (`prefix:local`) for `open`/`close` tokens. */
  readonly name?: string;
  /** Everything between the element name and the closing `>`/`/>`, trimmed. */
  readonly rawAttrs?: string;
  readonly selfClosing?: boolean;
}

const TOKEN_RE =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE(?:[^[>]|\[[^\]]*\])*>|<\/(?:[^<>"']|"[^"]*"|'[^']*')*>|<[^!?/](?:[^<>"']|"[^"]*"|'[^']*')*>|[^<]+/g;

/** Normalises CRLF/CR line endings to `\n`. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** The local part of a possibly prefixed name. */
export function localNameOf(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * Tokenizes `text`. Returns `undefined` when the tokens do not contiguously cover the whole
 * string (i.e. the markup is malformed enough that a transform must leave it alone).
 */
export function tokenizeXml(text: string): XmlToken[] | undefined {
  const tokens: XmlToken[] = [];
  const re = new RegExp(TOKEN_RE);
  let match: RegExpExecArray | null;
  let cursor = 0;
  while ((match = re.exec(text)) !== null) {
    const raw = match[0];
    const start = match.index;
    if (start !== cursor) {
      return undefined;
    }
    const end = start + raw.length;
    cursor = end;
    if (raw.startsWith('<!--')) {
      tokens.push({ kind: 'comment', raw, start, end });
    } else if (raw.startsWith('<![CDATA[')) {
      tokens.push({ kind: 'cdata', raw, start, end });
    } else if (raw.startsWith('<?')) {
      tokens.push({ kind: 'pi', raw, start, end });
    } else if (/^<!DOCTYPE/i.test(raw)) {
      tokens.push({ kind: 'doctype', raw, start, end });
    } else if (raw.startsWith('</')) {
      const nameMatch = /^<\/\s*([^\s>]+)\s*>$/.exec(raw);
      if (nameMatch?.[1] === undefined) {
        return undefined;
      }
      tokens.push({ kind: 'close', raw, start, end, name: nameMatch[1] });
    } else if (raw.startsWith('<')) {
      const selfClosing = /\/>$/.test(raw);
      const nameMatch = /^<([^\s/>]+)/.exec(raw);
      if (nameMatch?.[1] === undefined) {
        return undefined;
      }
      const name = nameMatch[1];
      const attrsEnd = raw.length - (selfClosing ? 2 : 1);
      const rawAttrs = raw.slice(1 + name.length, attrsEnd).trim();
      tokens.push({ kind: 'open', raw, start, end, name, rawAttrs, selfClosing });
    } else {
      tokens.push({ kind: 'text', raw, start, end });
    }
  }
  return cursor === text.length ? tokens : undefined;
}

/** One element in a {@link buildRangeTree} result, with the source range it occupies. */
export interface XmlRangeNode {
  readonly name: string;
  readonly rawAttrs: string;
  readonly selfClosing: boolean;
  /** Offset of the `<` opening this element. */
  readonly start: number;
  /** Offset just past this element's closing `>`. */
  readonly end: number;
  /** Offsets of the element's inner content (equal to each other for a self-closing element). */
  readonly innerStart: number;
  readonly innerEnd: number;
  readonly children: readonly XmlRangeNode[];
  /** Tokens that are direct children of this element (text, comments, CDATA, PIs). */
  readonly leafTokens: readonly XmlToken[];
}

interface Frame {
  readonly name: string;
  readonly rawAttrs: string;
  readonly start: number;
  readonly innerStart: number;
  readonly children: XmlRangeNode[];
  readonly leafTokens: XmlToken[];
}

/**
 * Builds an element tree over `tokens`, keeping source ranges. Returns `undefined` when tags
 * are unbalanced or mismatched — again, a signal to leave the document alone.
 */
export function buildRangeTree(tokens: readonly XmlToken[]): XmlRangeNode[] | undefined {
  const roots: XmlRangeNode[] = [];
  const stack: Frame[] = [];
  const top = (): Frame | undefined => stack[stack.length - 1];
  const push = (node: XmlRangeNode): void => {
    (top()?.children ?? roots).push(node);
  };

  for (const token of tokens) {
    if (token.kind === 'open') {
      if (token.selfClosing === true) {
        push({
          name: token.name ?? '',
          rawAttrs: token.rawAttrs ?? '',
          selfClosing: true,
          start: token.start,
          end: token.end,
          innerStart: token.end,
          innerEnd: token.end,
          children: [],
          leafTokens: [],
        });
        continue;
      }
      stack.push({
        name: token.name ?? '',
        rawAttrs: token.rawAttrs ?? '',
        start: token.start,
        innerStart: token.end,
        children: [],
        leafTokens: [],
      });
      continue;
    }
    if (token.kind === 'close') {
      const frame = stack.pop();
      if (frame === undefined || frame.name !== token.name) {
        return undefined;
      }
      push({
        name: frame.name,
        rawAttrs: frame.rawAttrs,
        selfClosing: false,
        start: frame.start,
        end: token.end,
        innerStart: frame.innerStart,
        innerEnd: token.start,
        children: frame.children,
        leafTokens: frame.leafTokens,
      });
      continue;
    }
    top()?.leafTokens.push(token);
  }
  return stack.length === 0 ? roots : undefined;
}
