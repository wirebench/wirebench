/**
 * Where a cursor is in an XML text: the element path at an offset, and what a completion would
 * replace. Pure text, no DOM and no schema, so it is safe in the browser subpath (`xml/index.ts`).
 *
 * In `xml/` because core's XML and XPath helpers use it and core imports no protocol folder
 * (protocol modules spec §7.2). `xsd/locate.ts` keeps the half that reads a schema set, and
 * re-exports these names.
 */

import type { QName } from './qname.js';

/** A half-open character range in a text document. */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

/** What the completion provider needs to offer children of the element the cursor is in. */
export interface CompletionContext {
  /** Ancestor chain of the element that would contain the completed child, outermost first. */
  readonly path: readonly QName[];
  /** The (possibly empty) element name typed so far after `<`, including any prefix. */
  readonly partial: string;
  /** Namespace prefixes in scope at the cursor. */
  readonly prefixes: Readonly<Record<string, string>>;
  /** The range of `partial` in the document, to replace with the accepted completion. */
  readonly replaceRange: TextRange;
}

const OPEN_TAG_RE = /<([^\s/!?>][^\s/>]*)((?:\s+[^<>]*)?)\s*(\/?)>/g;
const ATTR_RE = /([:\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const XML_PREFIX = 'xml';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

interface Scope {
  readonly qname: QName;
  readonly prefixes: Readonly<Record<string, string>>;
}

/** Extracts `xmlns`/`xmlns:prefix` declarations from a tag's raw attribute text. */
function xmlnsDeclarations(rawAttrs: string): Record<string, string> {
  const decls: Record<string, string> = {};
  const re = new RegExp(ATTR_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawAttrs)) !== null) {
    const attrName = m[1] as string;
    const value = m[2] ?? m[3] ?? '';
    if (attrName === 'xmlns') {
      decls[''] = value;
    } else if (attrName.startsWith('xmlns:')) {
      decls[attrName.slice('xmlns:'.length)] = value;
    }
  }
  return decls;
}

function resolvePrefixed(name: string, prefixes: Readonly<Record<string, string>>): QName {
  const colon = name.indexOf(':');
  if (colon === -1) {
    return { namespaceUri: prefixes[''] ?? '', localName: name };
  }
  const prefix = name.slice(0, colon);
  const localName = name.slice(colon + 1);
  if (prefix === XML_PREFIX) {
    return { namespaceUri: XML_NS, localName };
  }
  return { namespaceUri: prefixes[prefix] ?? '', localName };
}

/**
 * Walks open/close tags textually (never a DOM parse) to find the in-scope
 * ancestor stack ending just before `offset`. Tolerant of an unfinished tag
 * at the cursor: a `<…` with no closing `>` yet in the text simply does not
 * match and is ignored.
 */
function scopeStackAt(text: string, offset: number): Scope[] {
  const stack: Scope[] = [];
  const re = new RegExp(OPEN_TAG_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const matchEnd = m.index + m[0].length;
    if (matchEnd > offset) {
      break;
    }
    const raw = m[0];
    if (raw.startsWith('</')) {
      // Tolerant of stray/mismatched close tags: just pop, since the source text
      // up to the cursor is assumed well-formed for the purpose of this walk.
      if (stack.length > 0) {
        stack.pop();
      }
      continue;
    }
    const name = (m[1] as string).replace(/^\//, '');
    const rawAttrs = m[2] ?? '';
    const selfClosing = m[3] === '/';
    const parentPrefixes = stack.length > 0 ? (stack[stack.length - 1] as Scope).prefixes : {};
    const ownDecls = xmlnsDeclarations(rawAttrs);
    const prefixes = Object.keys(ownDecls).length > 0 ? { ...parentPrefixes, ...ownDecls } : parentPrefixes;
    const qname = resolvePrefixed(name, prefixes);
    if (!selfClosing) {
      stack.push({ qname, prefixes });
    }
  }
  return stack;
}

/**
 * Ancestor chain (outermost first) of the element containing `offset`,
 * resolved to expanded QNames via the `xmlns` declarations in scope at that
 * point in the text.
 */
export function elementPathAt(text: string, offset: number): QName[] {
  return scopeStackAt(text, offset).map((s) => s.qname);
}

/**
 * Pure text analysis for the completion provider: detects an in-progress
 * `<partial` element-name token ending at `offset` and reports the ancestor
 * path, in-scope prefixes and the range to replace with the accepted item.
 * Returns `undefined` when the cursor is not positioned right after an open
 * `<` (e.g. mid-attribute, or not inside a tag at all).
 */
export function completionContextAt(text: string, offset: number): CompletionContext | undefined {
  const before = text.slice(0, offset);
  const ltIndex = before.lastIndexOf('<');
  if (ltIndex === -1) {
    return undefined;
  }
  const between = text.slice(ltIndex + 1, offset);
  if (/[\s>/]/.test(between) || between.startsWith('/')) {
    return undefined;
  }
  let end = offset;
  while (end < text.length && /[\w:.-]/.test(text[end] as string)) {
    end += 1;
  }
  const path = elementPathAt(text, ltIndex);
  const scope = scopeStackAt(text, ltIndex);
  const prefixes = scope.length > 0 ? (scope[scope.length - 1] as Scope).prefixes : {};
  return {
    path,
    partial: between,
    prefixes,
    replaceRange: { start: ltIndex + 1, end },
  };
}
