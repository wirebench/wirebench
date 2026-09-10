/**
 * Structural parsing of a SOAP response envelope. Transport concerns (status
 * codes, redirects, MTOM) belong to the HTTP layer; this module only turns
 * response XML into the envelope's parts.
 */

import type { Element } from '@xmldom/xmldom';
import { WirebenchError } from '../errors.js';
import { parseXml } from '../xml/parse.js';
import type { SoapEnvelopeVersion } from './envelope.js';
import { detectEnvelopeVersion, envelopeNamespace } from './envelope.js';
import type { SoapFault } from './fault.js';
import { parseFault } from './fault.js';

/** The dissected parts of a SOAP response envelope. */
export interface ParsedSoapResponse {
  readonly version: SoapEnvelopeVersion;
  readonly envelope: Element;
  /** The `Header` element, when the response carries one. */
  readonly header?: Element;
  readonly body: Element;
  /** The `Body`'s element children, in document order (empty for an empty body). */
  readonly bodyChildren: readonly Element[];
  /** The parsed fault, when the body carries one. */
  readonly fault?: SoapFault;
}

/** Element children of `parent` in the given namespace, in document order. */
function childElementsNS(parent: Element, namespaceUri: string, localName?: string): Element[] {
  const result: Element[] = [];
  for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType !== 1) {
      continue;
    }
    const element = node as Element;
    if (element.namespaceURI !== namespaceUri) {
      continue;
    }
    if (localName === undefined || element.localName === localName) {
      result.push(element);
    }
  }
  return result;
}

/** Every element child of `parent`, in document order. */
function allChildElements(parent: Element): Element[] {
  const result: Element[] = [];
  for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType === 1) {
      result.push(node as Element);
    }
  }
  return result;
}

/**
 * Parses a SOAP response envelope into its header, body and fault.
 *
 * @param xml the raw response body
 * @throws {WirebenchError} `xml-parse-error` (propagated from {@link parseXml}) for malformed XML
 * @throws {WirebenchError} `not-a-soap-envelope` when the root is not an `Envelope` in either SOAP namespace,
 *   or when such an envelope has no `Body`; the caller decides how to surface a non-SOAP response
 */
export function parseSoapResponse(xml: string): ParsedSoapResponse {
  const doc = parseXml(xml);
  const version = detectEnvelopeVersion(doc);
  const envelope = doc.documentElement;
  if (version === undefined || envelope === null) {
    throw new WirebenchError('not-a-soap-envelope', 'Response is not a SOAP Envelope', {
      details: { rootTag: envelope?.tagName ?? null, rootNamespace: envelope?.namespaceURI ?? null },
    });
  }
  const ns = envelopeNamespace(version);
  const body = childElementsNS(envelope, ns, 'Body')[0];
  if (body === undefined) {
    throw new WirebenchError('not-a-soap-envelope', 'SOAP Envelope has no Body element', {
      details: { version },
    });
  }
  const header = childElementsNS(envelope, ns, 'Header')[0];
  const fault = parseFault(doc);
  return {
    version,
    envelope,
    ...(header !== undefined ? { header } : {}),
    body,
    bodyChildren: allChildElements(body),
    ...(fault !== undefined ? { fault } : {}),
  };
}
