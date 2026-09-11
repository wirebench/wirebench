/**
 * Shared DOM and HTTP navigation for the message-level WS-I assertions.
 *
 * The message assertions look at the bytes that actually went on the wire, so they work on the
 * parsed envelope plus the HTTP metadata rather than on any model: the profile constrains
 * constructs (a `DOCTYPE`, a processing instruction, an attribute nobody models) that a parsed
 * SOAP message would otherwise normalise away.
 */

import type { Element, Node } from '@xmldom/xmldom';
import { NS } from '../../../../xml/namespaces.js';
import { childElements, firstChildElement } from '../../../../wsdl/dom-utils.js';
import type { WsiFinding, WsiMessageContext, WsiMessageView } from '../../types.js';
import { descendants, findingAt } from '../helpers.js';

/** The envelope namespace a SOAP version uses. */
export const SOAP_ENVELOPE_NS: Readonly<Record<'1.1' | '1.2', string>> = {
  '1.1': NS.SOAP11_ENV,
  '1.2': NS.SOAP12_ENV,
};

/** The encoding namespace a SOAP version uses. */
export const SOAP_ENCODING_NS: Readonly<Record<'1.1' | '1.2', string>> = {
  '1.1': NS.SOAP11_ENC,
  '1.2': NS.SOAP12_ENC,
};

/** Every message half that actually parsed into a `soap:Envelope`. */
export function envelopes(context: WsiMessageContext): readonly WsiMessageView[] {
  return context.messages.filter((view) => view.envelope !== undefined && view.soapNs !== undefined);
}

/** Builds a finding pointing at `element`, attributed to the half it was found in. */
export function messageFinding(view: WsiMessageView, element: Element, message: string): WsiFinding {
  return findingAt(view.direction, element, message);
}

/** Builds a finding about a half as a whole (an HTTP header, a missing envelope). */
export function viewFinding(view: WsiMessageView, message: string): WsiFinding {
  return { message, location: { document: view.direction } };
}

/** The envelope element and every element beneath it, in document order. */
export function envelopeElements(view: WsiMessageView): readonly Element[] {
  const envelope = view.envelope;
  return envelope === undefined ? [] : [envelope, ...descendants(envelope)];
}

/** The element children of `parent`, in document order (whatever their namespace). */
export function elementChildren(parent: Element): readonly Element[] {
  const out: Element[] = [];
  let child: Node | null = parent.firstChild;
  while (child !== null) {
    if (child.nodeType === 1) {
      out.push(child as Element);
    }
    child = child.nextSibling;
  }
  return out;
}

/** The element children of `soap:Envelope`, in document order (whatever their namespace). */
export function envelopeChildren(view: WsiMessageView): readonly Element[] {
  const envelope = view.envelope;
  return envelope === undefined ? [] : elementChildren(envelope);
}

/** The `soap:Body` of a half, when it has exactly the one the profile requires. */
export function bodyOf(view: WsiMessageView): Element | undefined {
  const envelope = view.envelope;
  return envelope === undefined || view.soapNs === undefined
    ? undefined
    : firstChildElement(envelope, view.soapNs, 'Body');
}

/** The `soap:Header` of a half, when it declares one. */
export function headerOf(view: WsiMessageView): Element | undefined {
  const envelope = view.envelope;
  return envelope === undefined || view.soapNs === undefined
    ? undefined
    : firstChildElement(envelope, view.soapNs, 'Header');
}

/** The `soap:Fault` carried directly by `soap:Body`, when the half is a fault. */
export function faultOf(view: WsiMessageView): Element | undefined {
  const body = bodyOf(view);
  return body === undefined || view.soapNs === undefined ? undefined : firstChildElement(body, view.soapNs, 'Fault');
}

/** The element children of `soap:Body`, in document order. */
export function bodyChildren(view: WsiMessageView): readonly Element[] {
  const body = bodyOf(view);
  return body === undefined ? [] : elementChildren(body);
}

/** Every attribute of `element`, as a plain list (xmldom's `attributes` is a live NamedNodeMap). */
export function attributesOf(
  element: Element,
): readonly { name: string; localName: string; namespaceUri: string | null; value: string }[] {
  const out: { name: string; localName: string; namespaceUri: string | null; value: string }[] = [];
  const attributes = element.attributes;
  for (let index = 0; index < attributes.length; index += 1) {
    const attribute = attributes.item(index);
    if (attribute !== null) {
      out.push({
        name: attribute.name,
        localName: attribute.localName ?? attribute.name,
        namespaceUri: attribute.namespaceURI,
        value: attribute.value,
      });
    }
  }
  return out;
}

/** The media type of a `Content-Type` value, lower-cased and stripped of its parameters. */
export function mediaTypeOf(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

/** The `charset` parameter of a `Content-Type` value, when it states one. */
export function charsetOf(contentType: string): string | undefined {
  const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType);
  return match?.[1]?.trim();
}

/** One header of a half, by its (already lower-cased) name. */
export function headerValue(view: WsiMessageView, name: string): string | undefined {
  return view.headers[name];
}

/** The prefixes in scope on `element`, mapped to the namespace they are bound to. */
export function inScopePrefixes(element: Element): ReadonlyMap<string, string> {
  const prefixes = new Map<string, string>();
  let current: Element | null = element;
  while (current !== null && current.nodeType === 1) {
    for (const attribute of attributesOf(current)) {
      if (attribute.name === 'xmlns' && !prefixes.has('')) {
        prefixes.set('', attribute.value);
      } else if (attribute.name.startsWith('xmlns:') && !prefixes.has(attribute.localName)) {
        prefixes.set(attribute.localName, attribute.value);
      }
    }
    const parent: Node | null = current.parentNode;
    current = parent !== null && parent.nodeType === 1 ? (parent as Element) : null;
  }
  return prefixes;
}

/**
 * The first unqualified child element of `parent` with this local name. SOAP 1.1 declares the
 * fault's children in no namespace, and xmldom reports that as a `null` `namespaceURI`, which
 * `childElements(parent, '', name)` does not match.
 */
export function unqualifiedChild(parent: Element, localName: string): Element | undefined {
  let child: Node | null = parent.firstChild;
  while (child !== null) {
    if (child.nodeType === 1) {
      const element = child as Element;
      const ns = element.namespaceURI;
      if ((ns === null || ns === '') && element.localName === localName) {
        return element;
      }
    }
    child = child.nextSibling;
  }
  return undefined;
}

/** Every `soap:Header` block (its element children), in document order. */
export function headerBlocks(view: WsiMessageView): readonly Element[] {
  const header = headerOf(view);
  return header === undefined ? [] : elementChildren(header);
}

/** The `soap:Body` children of a half, skipping the `soap:Fault` (which has its own rules). */
export function partAccessors(view: WsiMessageView): readonly Element[] {
  const fault = faultOf(view);
  return bodyChildren(view).filter((child) => child !== fault);
}

/** The number of `soap:Body` elements directly under `soap:Envelope`. */
export function bodyCount(view: WsiMessageView): number {
  const envelope = view.envelope;
  return envelope === undefined || view.soapNs === undefined ? 0 : childElements(envelope, view.soapNs, 'Body').length;
}

/** The number of `soap:Header` elements directly under `soap:Envelope`. */
export function headerCount(view: WsiMessageView): number {
  const envelope = view.envelope;
  return envelope === undefined || view.soapNs === undefined
    ? 0
    : childElements(envelope, view.soapNs, 'Header').length;
}
