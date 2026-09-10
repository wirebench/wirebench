/**
 * Namespace discovery for the XPath/XQuery scratchpad: what prefixes are already bound in a
 * response document, and what the engine would suggest for the ones that aren't.
 */

import type { Element, Node } from '@xmldom/xmldom';
import { parseXml } from '../xml/parse.js';
import { prefixForNamespace } from '../soap/prefixes.js';

/** True for element nodes (xmldom `nodeType` 1) — the only nodes that carry `xmlns:*` attributes. */
function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

/**
 * Collects every namespace prefix declared anywhere in `xml`, first binding wins (outermost
 * declaration first, since traversal is document order and a descendant re-declaring a prefix
 * does not overwrite the ancestor's entry here — the scratchpad only needs *a* usable binding
 * per prefix, not exact in-scope shadowing at every node).
 *
 * The default namespace (`xmlns="..."`) is exposed under the empty-string key `''`; the caller
 * (the Query view's namespace table) lets the user assign it a real prefix before running a
 * query, since XPath has no syntax for referring to the default namespace directly.
 *
 * @param xml a well-formed XML document (typically a response envelope)
 * @returns prefix (or `''` for the default namespace) to namespace URI
 */
export function collectNamespaces(xml: string): Record<string, string> {
  const doc = parseXml(xml);
  const bindings: Record<string, string> = {};

  const visit = (node: Node): void => {
    if (isElement(node)) {
      const attributes = node.attributes;
      for (let i = 0; i < attributes.length; i += 1) {
        const attr = attributes.item(i);
        /* v8 ignore next 3 -- `i < attributes.length` guarantees `item(i)` is non-null */
        if (attr === null) {
          continue;
        }
        if (attr.name === 'xmlns') {
          if (!('' in bindings)) {
            bindings[''] = attr.value;
          }
        } else if (attr.name.startsWith('xmlns:')) {
          const prefix = attr.name.slice('xmlns:'.length);
          if (!(prefix in bindings)) {
            bindings[prefix] = attr.value;
          }
        }
      }
    }
    for (let child = node.firstChild; child !== null; child = child.nextSibling) {
      visit(child);
    }
  };

  /* v8 ignore next 3 -- `parseXml` throws before returning a document with no root element */
  if (doc.documentElement !== null) {
    visit(doc.documentElement);
  }
  return bindings;
}

/**
 * Suggests a prefix for every namespace URI used by an element or attribute in `xml` that has
 * no prefix bound to it by {@link collectNamespaces} (e.g. the document only declares it as the
 * default namespace, or an attribute uses a namespace no element declaration names). Reuses the
 * engine's conventional-prefix heuristic ({@link prefixForNamespace}) so suggestions match what
 * the rest of Wirebench would generate for the same URI.
 *
 * @param xml a well-formed XML document
 * @returns namespace URI to suggested prefix, for URIs {@link collectNamespaces} left unbound
 */
export function suggestPrefixes(xml: string): Record<string, string> {
  const doc = parseXml(xml);
  const bound = collectNamespaces(xml);
  // Only a *real* prefix (not the default namespace's '' entry) lets an XPath expression
  // address the namespace directly — a URI bound only as the default namespace still needs a
  // suggestion here even though `collectNamespaces` already reports it under ''.
  const boundUris = new Set(
    Object.entries(bound)
      .filter(([prefix]) => prefix !== '')
      .map(([, uri]) => uri),
  );
  const taken = new Set(Object.keys(bound).filter((prefix) => prefix !== ''));
  const suggestions: Record<string, string> = {};

  // Attributes are never affected: an attribute can only carry a namespace URI via an explicit
  // prefix (there is no such thing as a "default namespace" attribute in XML), and that prefix
  // is always one `collectNamespaces` already found — so only element namespaces can be unbound.
  const visit = (node: Node): void => {
    if (isElement(node)) {
      const uri = node.namespaceURI;
      if (uri !== null && uri !== '' && !boundUris.has(uri) && !(uri in suggestions)) {
        const prefix = prefixForNamespace(uri, taken);
        taken.add(prefix);
        suggestions[uri] = prefix;
      }
    }
    for (let child = node.firstChild; child !== null; child = child.nextSibling) {
      visit(child);
    }
  };

  /* v8 ignore next 3 -- `parseXml` throws before returning a document with no root element */
  if (doc.documentElement !== null) {
    visit(doc.documentElement);
  }
  return suggestions;
}
