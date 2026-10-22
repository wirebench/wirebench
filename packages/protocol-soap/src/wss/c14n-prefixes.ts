/**
 * The `InclusiveNamespaces PrefixList` exclusive canonicalization needs to be told about.
 *
 * Exclusive c14n's "visible utilization" rule only looks at element and attribute *names*, so a
 * prefix a subtree uses only inside an attribute value or in text — `xsi:type="tns:Foo"`, a
 * WSDL/XSD `ref`, a `QName` element body — loses its declaration and the canonical form stops
 * meaning what it said. Both `outgoing/signature.ts` (per-reference transforms) and
 * `outgoing/encryption.ts` (the plaintext it canonicalizes before encrypting) need the same
 * list, so the rule lives here once.
 */

import type { Element, Node } from '@xmldom/xmldom';

/** The namespace `xmlns:*` declarations themselves live in. */
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

/**
 * Matches a `prefix:localName`-shaped token, the way a QName looks when it appears as an
 * attribute value or as element text (`xsi:type="tns:Foo"`, a WSDL/XSD `ref` value, and so on).
 */
const QNAME_TOKEN = /\b([A-Za-z_][\w.-]*):[A-Za-z_][\w.-]*/g;

/** The prefixes `element` declares on itself via `xmlns:*` attributes. */
function ownDeclaredPrefixes(element: Element): Set<string> {
  const declared = new Set<string>();
  const attributes = element.attributes;
  for (let i = 0; i < attributes.length; i += 1) {
    const attribute = attributes.item(i);
    if (
      attribute !== null &&
      attribute.namespaceURI === XMLNS_NS &&
      attribute.prefix === 'xmlns' &&
      attribute.localName !== null
    ) {
      declared.add(attribute.localName);
    }
  }
  return declared;
}

/** Every `prefix:local` token found in attribute values or text content under `element`. */
function qnamePrefixesIn(element: Element): Set<string> {
  const found = new Set<string>();
  const scan = (text: string): void => {
    QNAME_TOKEN.lastIndex = 0;
    let match = QNAME_TOKEN.exec(text);
    while (match !== null) {
      const prefix = match[1];
      if (prefix !== undefined) {
        found.add(prefix);
      }
      match = QNAME_TOKEN.exec(text);
    }
  };
  const walk = (node: Node): void => {
    if (node.nodeType === 1) {
      const el = node as Element;
      const attributes = el.attributes;
      for (let i = 0; i < attributes.length; i += 1) {
        const attribute = attributes.item(i);
        if (attribute !== null && attribute.namespaceURI !== XMLNS_NS) {
          scan(attribute.value);
        }
      }
      for (let child = el.firstChild; child !== null; child = child.nextSibling) {
        walk(child);
      }
    } else if (node.nodeType === 3) {
      scan(node.nodeValue ?? '');
    }
  };
  walk(element);
  return found;
}

/**
 * The `InclusiveNamespaces PrefixList` exclusive c14n of `element` needs: every prefix
 * `element`'s subtree references only through attribute-value or text QName content — a use
 * exclusive c14n's "visible utilization" rule does not see — plus `envelopePrefix` when one is
 * given.
 *
 * A prefix `element` already declares on itself is left out: exclusive c14n renders that
 * declaration regardless, so listing it again would be redundant, not wrong.
 *
 * @param element the element about to be canonicalized
 * @param envelopePrefix the SOAP envelope's own prefix when the canonical form has to stand on
 *   its own inside the envelope (a signature reference), or `null` when it does not (an
 *   encrypted plaintext, which is self-contained by construction)
 * @returns the prefixes to list, sorted, so the value is stable
 */
export function inclusiveNamespacePrefixList(element: Element, envelopePrefix: string | null): string[] {
  const declared = ownDeclaredPrefixes(element);
  const prefixes = new Set<string>();
  if (envelopePrefix !== null && envelopePrefix !== '') {
    prefixes.add(envelopePrefix);
  }
  for (const prefix of qnamePrefixesIn(element)) {
    if (!declared.has(prefix) && element.lookupNamespaceURI(prefix) !== null) {
      prefixes.add(prefix);
    }
  }
  return [...prefixes].sort();
}
