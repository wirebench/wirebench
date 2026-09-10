/**
 * SOAP fault parsing for both versions.
 *
 * SOAP 1.1 (§4.4) and SOAP 1.2 (Part 1 §5.4) describe structurally different
 * faults; this module normalises them onto one shape so callers never branch
 * on the version to show a fault to the user.
 */

import type { Document, Element } from '@xmldom/xmldom';
import { NS } from '../xml/namespaces.js';
import { serializeXml } from '../xml/serialize.js';
import type { SoapEnvelopeVersion } from './envelope.js';

/** One localised `Reason/Text` of a SOAP 1.2 fault. */
export interface FaultReason {
  /** The `xml:lang` of this text, when the server supplied one. */
  readonly lang?: string;
  readonly text: string;
}

/** A SOAP fault, normalised across SOAP 1.1 and 1.2. */
export interface SoapFault {
  readonly version: SoapEnvelopeVersion;
  /** 1.1: the `faultcode` text. 1.2: the `Code/Value` text. Both keep their lexical prefix. */
  readonly code: string;
  /** 1.2 only: the nested `Subcode/Value` chain, outermost first. Empty for 1.1. */
  readonly subcodes: readonly string[];
  /** 1.1: `faultstring`. 1.2: the first `Reason/Text`. */
  readonly reason: string;
  /** 1.2 only: every `Reason/Text` with its `xml:lang`. */
  readonly reasons?: readonly FaultReason[];
  /** 1.1 only: `faultactor`. */
  readonly actor?: string;
  /** 1.2 only: `Role`. */
  readonly role?: string;
  /** 1.2 only: `Node`. */
  readonly node?: string;
  /** The serialized *children* of `detail`/`Detail`, when it has element children. */
  readonly detailXml?: string;
  /** The `Fault` element itself, for callers that need to inspect it further. */
  readonly element: Element;
}

/** Element children of `parent`, optionally filtered by namespace and local name. */
function children(parent: Element, namespaceUri?: string, localName?: string): Element[] {
  const result: Element[] = [];
  for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType !== 1) {
      continue;
    }
    const element = node as Element;
    // SOAP 1.1's fault children are unqualified; `namespaceUri: undefined` means "any".
    if (namespaceUri !== undefined && element.namespaceURI !== namespaceUri) {
      continue;
    }
    if (localName !== undefined && element.localName !== localName) {
      continue;
    }
    result.push(element);
  }
  return result;
}

/** The first matching child element, or `undefined`. */
function child(parent: Element, namespaceUri: string | undefined, localName: string): Element | undefined {
  return children(parent, namespaceUri, localName)[0];
}

/** The concatenated text content of `element`, trimmed. */
function textOf(element: Element | undefined): string {
  return element?.textContent?.trim() ?? '';
}

/** The `soapenv:Body` of a parsed envelope, if the document is one. */
function bodyOf(doc: Document): { readonly body: Element; readonly version: SoapEnvelopeVersion } | undefined {
  const root = doc.documentElement;
  if (root === null || root.localName !== 'Envelope') {
    return undefined;
  }
  const version: SoapEnvelopeVersion | undefined =
    root.namespaceURI === NS.SOAP11_ENV ? '1.1' : root.namespaceURI === NS.SOAP12_ENV ? '1.2' : undefined;
  if (version === undefined) {
    return undefined;
  }
  const body = child(root, root.namespaceURI ?? undefined, 'Body');
  return body === undefined ? undefined : { body, version };
}

/** Serializes the element children of a `detail` element, one per line. */
function detailXmlOf(detail: Element | undefined): string | undefined {
  if (detail === undefined) {
    return undefined;
  }
  const elements = children(detail);
  return elements.length === 0 ? undefined : elements.map((element) => serializeXml(element)).join('\n');
}

/** Walks the nested `Subcode/Value` chain of a SOAP 1.2 `Code`, outermost first. */
function subcodesOf(code: Element, envelopeNs: string): string[] {
  const result: string[] = [];
  let current = child(code, envelopeNs, 'Subcode');
  while (current !== undefined) {
    result.push(textOf(child(current, envelopeNs, 'Value')));
    current = child(current, envelopeNs, 'Subcode');
  }
  return result;
}

function parseFault11(fault: Element): SoapFault {
  // SOAP 1.1 fault children are unqualified, but servers in the wild
  // occasionally qualify them; matching on local name alone accepts both.
  const actor = child(fault, undefined, 'faultactor');
  const detailXml = detailXmlOf(child(fault, undefined, 'detail'));
  return {
    version: '1.1',
    code: textOf(child(fault, undefined, 'faultcode')),
    subcodes: [],
    reason: textOf(child(fault, undefined, 'faultstring')),
    ...(actor !== undefined ? { actor: textOf(actor) } : {}),
    ...(detailXml !== undefined ? { detailXml } : {}),
    element: fault,
  };
}

function parseFault12(fault: Element): SoapFault {
  const ns = NS.SOAP12_ENV;
  const code = child(fault, ns, 'Code');
  const reasonEl = child(fault, ns, 'Reason');
  const reasons: FaultReason[] =
    reasonEl === undefined
      ? []
      : children(reasonEl, ns, 'Text').map((text) => {
          const lang = text.getAttributeNS(NS.XML, 'lang') ?? text.getAttribute('xml:lang');
          return { ...(lang !== null && lang !== '' ? { lang } : {}), text: textOf(text) };
        });
  const role = child(fault, ns, 'Role');
  const node = child(fault, ns, 'Node');
  const detailXml = detailXmlOf(child(fault, ns, 'Detail'));
  return {
    version: '1.2',
    code: code === undefined ? '' : textOf(child(code, ns, 'Value')),
    subcodes: code === undefined ? [] : subcodesOf(code, ns),
    reason: reasons[0]?.text ?? '',
    reasons,
    ...(role !== undefined ? { role: textOf(role) } : {}),
    ...(node !== undefined ? { node: textOf(node) } : {}),
    ...(detailXml !== undefined ? { detailXml } : {}),
    element: fault,
  };
}

/**
 * Parses the SOAP fault in a response document, or returns `undefined` when
 * the document is not a SOAP envelope or its `Body` carries no `Fault`.
 *
 * @param doc a parsed SOAP response
 */
export function parseFault(doc: Document): SoapFault | undefined {
  const found = bodyOf(doc);
  if (found === undefined) {
    return undefined;
  }
  const envelopeNs = found.version === '1.2' ? NS.SOAP12_ENV : NS.SOAP11_ENV;
  const fault = child(found.body, envelopeNs, 'Fault');
  if (fault === undefined) {
    return undefined;
  }
  return found.version === '1.2' ? parseFault12(fault) : parseFault11(fault);
}

/** True when the document is a SOAP envelope whose `Body` carries a `Fault`. */
export function isSoapFault(doc: Document): boolean {
  return parseFault(doc) !== undefined;
}
