/**
 * A SOAP mock serving its WSDL (spec §Serving the WSDL): `?wsdl` is the root document, `?wsdl=<n>` and
 * `?xsd=<n>` the bundle's other documents by index. In each, the service addresses point at the mock
 * and every import or include that resolves to a bundled document points at its `?wsdl=`/`?xsd=` URL,
 * so a client that fetches the WSDL from the mock gets the whole contract from the mock.
 *
 * Only bundle documents can be served, by index: a request cannot name a path or a URL.
 */

import type { Element, Node } from '@xmldom/xmldom';
import type { MockReply, MockRequest } from '../mock/contract.js';
import type { BundledDocument, DefinitionBundle } from '../wsdl/resolver.js';
import { parseXml } from '../xml/parse.js';
import { serializeXml } from '../xml/serialize.js';

const WSDL_NS = 'http://schemas.xmlsoap.org/wsdl/';
const XSD_NS = 'http://www.w3.org/2001/XMLSchema';
const ADDRESS_NAMESPACES = new Set([
  'http://schemas.xmlsoap.org/wsdl/soap/',
  'http://schemas.xmlsoap.org/wsdl/soap12/',
]);

/** The query key (`wsdl` or `xsd`, any case) and its value, when the request asks for a document. */
function asked(request: MockRequest): { readonly kind: 'wsdl' | 'xsd'; readonly value: string } | undefined {
  for (const [key, values] of Object.entries(request.query)) {
    const lower = key.toLowerCase();
    if (lower === 'wsdl' || lower === 'xsd') {
      return { kind: lower, value: values[0] ?? '' };
    }
  }
  return undefined;
}

/** The URL a bundled document is served at. */
function servedAt(bundle: DefinitionBundle, index: number, mockUrl: string): string {
  const document = bundle.documents[index];
  if (index === 0) return `${mockUrl}?wsdl`;
  return `${mockUrl}?${document?.kind === 'xsd' ? 'xsd' : 'wsdl'}=${String(index)}`;
}

function indexOf(bundle: DefinitionBundle, reference: string, base: string): number | undefined {
  let resolved: string;
  try {
    resolved = new URL(reference, base).href;
  } catch {
    return undefined;
  }
  const index = bundle.documents.findIndex(
    (document) => document.location === resolved || document.requestedLocation === resolved,
  );
  return index === -1 ? undefined : index;
}

function rewrite(bundle: DefinitionBundle, document: BundledDocument, mockUrl: string): string {
  const parsed = parseXml(document.text, { location: document.location });
  const visit = (node: Node): void => {
    if (node.nodeType === 1) {
      const element = node as Element;
      const ns = element.namespaceURI ?? '';
      const local = element.localName ?? '';
      if (local === 'address' && ADDRESS_NAMESPACES.has(ns) && element.hasAttribute('location')) {
        element.setAttribute('location', mockUrl);
      }
      const attribute =
        ns === WSDL_NS && local === 'import'
          ? 'location'
          : ns === XSD_NS && (local === 'import' || local === 'include' || local === 'redefine')
            ? 'schemaLocation'
            : undefined;
      if (attribute !== undefined && element.hasAttribute(attribute)) {
        const index = indexOf(bundle, element.getAttribute(attribute) ?? '', document.location);
        if (index !== undefined) {
          element.setAttribute(attribute, servedAt(bundle, index, mockUrl));
        }
      }
    }
    for (let child = node.firstChild; child !== null; child = child.nextSibling) {
      visit(child);
    }
  };
  visit(parsed);
  return serializeXml(parsed);
}

function notFound(text: string): MockReply {
  return { status: 404, headers: [['Content-Type', 'text/plain; charset=utf-8']], body: `${text}\n` };
}

/**
 * The definition document a `GET` asks for, rewritten for `mockUrl`; `undefined` when the request
 * does not ask for one (so it is routed as an ordinary request).
 */
export function definitionReply(
  bundle: DefinitionBundle,
  request: MockRequest,
  mockUrl: string,
): MockReply | undefined {
  if (request.method !== 'GET') return undefined;
  const wanted = asked(request);
  if (wanted === undefined) return undefined;
  let index = 0;
  if (wanted.value !== '') {
    if (!/^\d{1,4}$/.test(wanted.value)) return notFound(`No document ${wanted.value}`);
    index = Number(wanted.value);
  }
  const document = bundle.documents[index];
  if (document === undefined || document.kind !== wanted.kind) {
    return notFound(`No ${wanted.kind} document ${String(index)}`);
  }
  return {
    status: 200,
    headers: [['Content-Type', 'text/xml; charset=utf-8']],
    body: rewrite(bundle, document, mockUrl),
  };
}
