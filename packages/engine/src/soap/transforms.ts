/**
 * The envelope transforms SoapUI applies on the way out, per request property:
 * "Remove Empty Content", "Strip Whitespaces", "Pretty Print" and "Entitize Properties".
 *
 * All four are text transforms over a tolerant tokenizer, never a DOM round trip: an envelope
 * a user hand-edited may not be well formed, and a transform that throws (or silently rewrites
 * attribute quoting) on the way to the wire is worse than one that does nothing. Every function
 * here returns its input unchanged when it cannot understand the document.
 *
 * Entitizing is the odd one out. SoapUI escapes the values substituted by property expansion,
 * which cannot be identified after the fact — by the time an envelope is a string, a `&` that
 * came from a property is indistinguishable from one the user typed. So {@link entitizeValue}
 * is applied *during* expansion instead (see `project/properties.ts`'s `entitize` option), and
 * lives here alongside its siblings.
 */

import { formatXml } from '../xml/pretty.js';
import { buildRangeTree, localNameOf, tokenizeXml } from '../xml/tolerant-tree.js';
import type { XmlRangeNode, XmlToken } from '../xml/tolerant-tree.js';

/** SOAP wrapper elements that "Remove Empty Content" must never delete. */
const WRAPPERS = new Set(['Envelope', 'Header', 'Body']);

/** The `?` SoapUI (and our sample generator) writes for an untouched leaf. */
const PLACEHOLDER_ONLY = /^[\s?]*$/;

/**
 * True when this element carries nothing worth sending: no attributes, no element children
 * that survived, and inner text that is empty, whitespace, or only `?` placeholders. A CDATA
 * section, a comment or a processing instruction counts as content.
 */
function isEmptyElement(node: XmlRangeNode, removed: ReadonlySet<XmlRangeNode>): boolean {
  if (WRAPPERS.has(localNameOf(node.name))) {
    return false;
  }
  if (node.rawAttrs !== '') {
    return false;
  }
  if (node.children.some((child) => !removed.has(child))) {
    return false;
  }
  for (const token of node.leafTokens) {
    if (token.kind !== 'text') {
      return false;
    }
    if (!PLACEHOLDER_ONLY.test(token.raw)) {
      return false;
    }
  }
  return true;
}

/** Collects every element that should disappear, deepest first so parents see their children's fate. */
function collectRemovals(nodes: readonly XmlRangeNode[], removed: Set<XmlRangeNode>): void {
  for (const node of nodes) {
    collectRemovals(node.children, removed);
    if (isEmptyElement(node, removed)) {
      removed.add(node);
    }
  }
}

/** Deletes `ranges` (non-overlapping, any order) from `text`. */
function cut(text: string, ranges: readonly { start: number; end: number }[]): string {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const range of sorted) {
    if (range.start < cursor) {
      continue;
    }
    out += text.slice(cursor, range.start);
    cursor = range.end;
  }
  return out + text.slice(cursor);
}

/**
 * SoapUI's "Remove Empty Content": drops every element that has no attributes and whose whole
 * content is empty, whitespace, or `?` placeholders — recursively, so a parent left with
 * nothing but removed children goes too. The `Envelope`/`Header`/`Body` wrappers are never
 * removed, however empty they are.
 *
 * @param xml the envelope text
 * @returns the transformed envelope, or `xml` unchanged when it could not be parsed
 */
export function removeEmptyContent(xml: string): string {
  const tokens = tokenizeXml(xml);
  if (tokens === undefined) {
    return xml;
  }
  const roots = buildRangeTree(tokens);
  if (roots === undefined) {
    return xml;
  }
  const removed = new Set<XmlRangeNode>();
  collectRemovals(roots, removed);
  if (removed.size === 0) {
    return xml;
  }
  // Only outermost removals matter: cutting a parent already takes its children with it.
  const outermost: XmlRangeNode[] = [];
  const walk = (nodes: readonly XmlRangeNode[]): void => {
    for (const node of nodes) {
      if (removed.has(node)) {
        outermost.push(node);
        continue;
      }
      walk(node.children);
    }
  };
  walk(roots);
  // Trailing whitespace on the line the element sat on goes with it, so removing a child does
  // not leave a blank, indented line behind.
  const ranges = outermost.map((node) => {
    let start = node.start;
    while (start > 0 && (xml[start - 1] === ' ' || xml[start - 1] === '\t')) {
      start -= 1;
    }
    let end = node.end;
    if (start > 0 && xml[start - 1] === '\n') {
      // Keep the newline that *precedes* the element only if the element is not the whole line.
      if (xml[end] === '\n') {
        end += 1;
      }
    }
    return { start, end };
  });
  return cut(xml, ranges);
}

/**
 * SoapUI's "Strip Whitespaces": drops whitespace-only text nodes between elements and trims
 * the leading/trailing whitespace of every other text node. CDATA sections, comments and
 * processing instructions are left exactly as they are.
 *
 * @param xml the envelope text
 * @returns the transformed envelope, or `xml` unchanged when it could not be tokenized
 */
export function stripWhitespaces(xml: string): string {
  const tokens = tokenizeXml(xml);
  if (tokens === undefined) {
    return xml;
  }
  let out = '';
  for (const token of tokens as readonly XmlToken[]) {
    out += token.kind === 'text' ? token.raw.trim() : token.raw;
  }
  return out;
}

/**
 * SoapUI's "Pretty Print": reformats the envelope with the given indent width.
 *
 * @param xml the envelope text
 * @param indentWidth spaces per nesting level; defaults to 3, the editor's default tab size
 * @returns the formatted envelope, or `xml` unchanged when it could not be formatted
 */
export function prettyPrint(xml: string, indentWidth = 3): string {
  const result = formatXml(xml, { indent: ' '.repeat(Math.max(0, indentWidth)) });
  return result.problem === undefined ? result.text : xml;
}

/**
 * SoapUI's "Entitize Properties", applied to one substituted property value: escapes the three
 * characters that would otherwise be read as markup once the value lands inside an envelope.
 *
 * `"` and `'` are deliberately left alone: expansion targets element content far more often
 * than an attribute value, and escaping quotes there would show up as `&quot;` in the payload.
 *
 * @param value the expanded property value
 */
export function entitizeValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
