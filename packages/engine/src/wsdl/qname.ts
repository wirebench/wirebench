import type { Element } from '@xmldom/xmldom';

/** A namespace-qualified name: an expanded `{namespaceUri}localName` pair. */
export interface QName {
  readonly namespaceUri: string;
  readonly localName: string;
}

/**
 * Resolves a (possibly prefixed) QName string against the namespaces in
 * scope at `contextElement`, walking ancestors via `lookupNamespaceURI`.
 *
 * An unprefixed name resolves, in order: (1) to the in-scope XML default
 * namespace (an `xmlns="…"` declared on `contextElement` or an ancestor),
 * when one is declared; (2) otherwise to `defaultNamespace`, when given
 * (callers pass the enclosing `wsdl:definitions` `targetNamespace` for WSDL
 * references, mirroring wsdl4j's lenient fallback for documents that omit a
 * default namespace declaration). This applies uniformly to every
 * QName-valued attribute (`message`, `binding`, `type`, `element`, part refs).
 *
 * @param prefixed the raw attribute value, e.g. `"tns:Add"` or `"Add"`
 * @param contextElement the element the value was read from, used to resolve prefixes in scope
 * @param defaultNamespace fallback namespace when `prefixed` carries no prefix and no default namespace is declared in scope
 * @throws {Error} if a prefix is present but not bound in scope
 */
export function parseQName(prefixed: string, contextElement: Element, defaultNamespace?: string): QName {
  const trimmed = prefixed.trim();
  const colonIndex = trimmed.indexOf(':');
  if (colonIndex === -1) {
    const declaredDefault = contextElement.lookupNamespaceURI('');
    const namespaceUri = declaredDefault ?? defaultNamespace ?? '';
    return { namespaceUri, localName: trimmed };
  }
  const prefix = trimmed.slice(0, colonIndex);
  const localName = trimmed.slice(colonIndex + 1);
  const namespaceUri = contextElement.lookupNamespaceURI(prefix);
  if (namespaceUri === null) {
    throw new Error(`Unbound namespace prefix "${prefix}" in QName "${prefixed}"`);
  }
  return { namespaceUri, localName };
}

/** True when two QNames refer to the same expanded name. */
export function qnameEquals(a: QName, b: QName): boolean {
  return a.namespaceUri === b.namespaceUri && a.localName === b.localName;
}

/** Renders a QName in Clark notation: `{namespaceUri}localName`. */
export function qnameToString(qname: QName): string {
  return `{${qname.namespaceUri}}${qname.localName}`;
}
