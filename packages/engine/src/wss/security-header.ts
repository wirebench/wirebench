/**
 * Locating the pieces of a secured envelope: the `soap:Header`, the `wsse:Security` block
 * addressed to a given actor/role, and arbitrary elements named by `{namespace, localName}`.
 * Shared by `apply.ts` (which builds the header) and `outgoing/signature.ts` (which has to find
 * it again after `xml-crypto` has re-serialized the document).
 */

import type { Document, Element } from '@xmldom/xmldom';
import { WssError } from '../errors.js';
import { NS } from '../xml/namespaces.js';
import { envelopeNamespace } from '../soap/envelope.js';
import type { SoapEnvelopeVersion } from '../soap/envelope.js';

/** The attribute name carrying the SOAP actor/role for `version`. */
export function actorAttribute(version: SoapEnvelopeVersion): string {
  return version === '1.2' ? 'role' : 'actor';
}

/** The `mustUnderstand` value `version` expects. */
export function mustUnderstandValue(version: SoapEnvelopeVersion): string {
  return version === '1.2' ? 'true' : '1';
}

/** The first child element of `parent` in `namespace` with local name `localName`. */
export function childElement(parent: Element, namespace: string, localName: string): Element | undefined {
  for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
    const element = node as Element;
    if (element.nodeType === 1 && element.namespaceURI === namespace && element.localName === localName) {
      return element;
    }
  }
  return undefined;
}

/** Every `wsse:Security` header block in `header`, in document order. */
export function securityHeaders(header: Element): Element[] {
  const found: Element[] = [];
  for (let node = header.firstChild; node !== null; node = node.nextSibling) {
    const element = node as Element;
    if (element.nodeType === 1 && element.namespaceURI === NS.WSSE && element.localName === 'Security') {
      found.push(element);
    }
  }
  return found;
}

/** The actor/role a `wsse:Security` element is addressed to, or `undefined` for the ultimate receiver. */
export function securityActor(security: Element, version: SoapEnvelopeVersion): string | undefined {
  const value = security.getAttributeNS(envelopeNamespace(version), actorAttribute(version));
  return value === null || value === '' ? undefined : value;
}

/**
 * The index (1-based, as XPath counts) of the `wsse:Security` block addressed to `actor`,
 * among `header`'s direct `wsse:Security` children — the same node set the XPath
 * `signEnvelope` hands `xml-crypto` selects, so the two never disagree about which block is
 * "the" one to sign into.
 *
 * @throws WssError `wss-security-missing` when no direct child is addressed to `actor`
 */
export function securityIndex(header: Element, version: SoapEnvelopeVersion, actor?: string): number {
  const index = securityHeaders(header).findIndex((element) => securityActor(element, version) === actor);
  if (index === -1) {
    throw new WssError(
      'wss-security-missing',
      'The envelope has no wsse:Security header addressed to the expected actor/role.',
    );
  }
  return index + 1;
}

/** The first descendant-or-self of `root` in `namespace` with local name `localName`. */
export function findElement(root: Element, namespace: string, localName: string): Element | undefined {
  if (root.namespaceURI === namespace && root.localName === localName) {
    return root;
  }
  for (let node = root.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType !== 1) {
      continue;
    }
    const found = findElement(node as Element, namespace, localName);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** Replaces `doc`'s document element with `replacement`'s, so callers holding `doc` stay valid. */
export function replaceDocumentElement(doc: Document, replacement: Document): void {
  const current = doc.documentElement;
  const next = replacement.documentElement;
  if (current === null || next === null) {
    return;
  }
  doc.replaceChild(doc.importNode(next, true), current);
}
