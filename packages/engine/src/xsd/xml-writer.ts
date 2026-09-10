/**
 * A tiny, dependency-free XML fragment writer used by the sample generator.
 *
 * It builds an element tree in memory and renders it with a fixed indent, so
 * namespace declarations discovered while walking a schema can still be added
 * to the fragment's root element once the walk is finished.
 */

import type { QName } from '../wsdl/qname.js';

/** A literal attribute on an emitted element. */
export interface XmlAttribute {
  readonly name: string;
  readonly value: string;
}

/** An emitted element, comment, or nothing at all. */
export type XmlNode = XmlElementNode | XmlCommentNode;

/** An element node; either a leaf carrying `text` or a container with `children`. */
export interface XmlElementNode {
  readonly kind: 'element';
  /** The already-prefixed tag name, e.g. `ns1:Add` or `intA`. */
  readonly name: string;
  attributes: XmlAttribute[];
  readonly children: XmlNode[];
  /** Simple content, rendered on the element's own line. */
  text?: string;
  /** A comment rendered immediately before {@link XmlElementNode.text}, inside the element. */
  leadingComment?: string;
}

/** A standalone comment line. */
export interface XmlCommentNode {
  readonly kind: 'comment';
  readonly text: string;
}

/** Creates an element node with no attributes and no children. */
export function element(name: string): XmlElementNode {
  return { kind: 'element', name, attributes: [], children: [] };
}

/** Creates a standalone comment node. */
export function comment(text: string): XmlCommentNode {
  return { kind: 'comment', text };
}

/** Escapes text content: `&`, `<` and `>` only, per XML's character-data rules. */
export function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escapes an attribute value, including the double quote it is delimited by. */
export function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

/** Neutralises `--` so a generated comment can never terminate early. */
function escapeComment(text: string): string {
  return text.replace(/--/g, '- -');
}

function renderAttributes(attributes: readonly XmlAttribute[]): string {
  return attributes.map((a) => ` ${a.name}="${escapeAttribute(a.value)}"`).join('');
}

function renderNode(node: XmlNode, indent: string, depth: number, out: string[]): void {
  const pad = indent.repeat(depth);
  if (node.kind === 'comment') {
    out.push(`${pad}<!--${escapeComment(node.text)}-->`);
    return;
  }
  const open = `<${node.name}${renderAttributes(node.attributes)}`;
  if (node.children.length === 0 && node.text === undefined && node.leadingComment === undefined) {
    out.push(`${pad}${open}/>`);
    return;
  }
  if (node.children.length === 0) {
    const inner = `${node.leadingComment !== undefined ? `<!--${escapeComment(node.leadingComment)}-->` : ''}${
      node.text !== undefined ? escapeText(node.text) : ''
    }`;
    out.push(`${pad}${open}>${inner}</${node.name}>`);
    return;
  }
  out.push(`${pad}${open}>`);
  for (const child of node.children) {
    renderNode(child, indent, depth + 1, out);
  }
  out.push(`${pad}</${node.name}>`);
}

/** Renders a node tree to a pretty-printed XML fragment (no XML declaration). */
export function renderXml(root: XmlNode, indent: string): string {
  const out: string[] = [];
  renderNode(root, indent, 0, out);
  return out.join('\n');
}

/** Assigns and remembers a stable prefix per namespace URI. */
export class PrefixTable {
  private readonly byUri = new Map<string, string>();
  private readonly taken = new Set<string>();
  private counter = 0;

  constructor(private readonly preferred: Readonly<Record<string, string>>) {}

  /** The prefix for `uri`, allocating one on first use. The empty namespace has no prefix. */
  prefixFor(uri: string, hint?: string): string {
    if (uri === '') {
      return '';
    }
    const existing = this.byUri.get(uri);
    if (existing !== undefined) {
      return existing;
    }
    const wanted = this.preferred[uri] ?? hint;
    let prefix = wanted !== undefined && !this.taken.has(wanted) ? wanted : '';
    while (prefix === '') {
      this.counter += 1;
      const candidate = `ns${this.counter}`;
      if (!this.taken.has(candidate)) {
        prefix = candidate;
      }
    }
    this.taken.add(prefix);
    this.byUri.set(uri, prefix);
    return prefix;
  }

  /** Renders `name` as a prefixed lexical QName. */
  qualify(name: QName, hint?: string): string {
    const prefix = this.prefixFor(name.namespaceUri, hint);
    return prefix === '' ? name.localName : `${prefix}:${name.localName}`;
  }

  /** Prefix → URI for every namespace used so far, in first-use order. */
  namespaces(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [uri, prefix] of this.byUri) {
      result[prefix] = uri;
    }
    return result;
  }
}
