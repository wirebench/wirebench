/**
 * The timeline of a `wsse:Security` header: each step it holds — timestamp, token, signature,
 * encryption — in header order, with what each signed or encrypted.
 *
 * Header order is a fact of the message; the order the sender *applied* the steps is not always
 * the same. This build appends each entry, so on a message it secured header order is the order
 * of the configuration. WS-Security 1.1 asks a sender to prepend instead, so on a message from
 * elsewhere the header usually lists the sender's last step first. The timeline reports the fact
 * and leaves that reading to the caller.
 */

import forge from 'node-forge';
import type { Element } from '@xmldom/xmldom';
import { NS } from '../xml/namespaces.js';
import { parseXml } from '../xml/parse.js';
import { commonNameOf } from '../keystore/certificate.js';
import { childElement, securityHeaders } from './security-header.js';
import { WSS_TOKEN_TYPES } from './key-identifiers.js';
import { algorithmName } from './incoming/check.js';

/** What kind of step a timeline entry is. */
export type WssTimelineStepKind = 'timestamp' | 'username-token' | 'token' | 'signature' | 'encryption' | 'other';

/** One child of a `wsse:Security` header, as the timeline lists it. */
export interface WssTimelineStep {
  readonly kind: WssTimelineStepKind;
  /** A one-line, human-readable account: `Signed Body, Timestamp (rsa-sha256, exc-c14n)`. */
  readonly summary: string;
  /** The elements a signature covers or an encryption hides (`Body (content)`); signature and encryption only. */
  readonly covers?: readonly string[];
  /** The step's own `Id`/`wsu:Id`, when it has one. */
  readonly id?: string;
  /** The actor/role the header is addressed to; absent for the ultimate receiver. */
  readonly actor?: string;
}

/** A step before the header's actor is attached. */
type Step = Omit<WssTimelineStep, 'actor'>;

/** Every element under `root` by the value of an attribute named `Id` (any namespace); first wins. */
function idIndex(root: Element): Map<string, Element> {
  const index = new Map<string, Element>();
  const walk = (node: Element): void => {
    const id = idOf(node);
    if (id !== undefined && !index.has(id)) index.set(id, node);
    for (const child of elementChildren(node)) walk(child);
  };
  walk(root);
  return index;
}

/** The element children of `parent`, in document order. */
function elementChildren(parent: Element): Element[] {
  const found: Element[] = [];
  for (let child = parent.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === 1) found.push(child as Element);
  }
  return found;
}

/** The `Id` (in any namespace) of `element`, when it has one. */
function idOf(element: Element): string | undefined {
  for (let position = 0; position < element.attributes.length; position += 1) {
    const attribute = element.attributes.item(position);
    if (attribute?.localName === 'Id' && attribute.value !== '') return attribute.value;
  }
  return undefined;
}

/** The fragment of a URI (`…#aes256-gcm` → `aes256-gcm`), or the URI when it has none. */
function fragment(uri: string): string {
  const hash = uri.lastIndexOf('#');
  return hash === -1 ? uri : uri.slice(hash + 1);
}

/** The trimmed text of the child `localName` of `parent` in `namespace`, when not empty. */
function childText(parent: Element, namespace: string, localName: string): string | undefined {
  const text = childElement(parent, namespace, localName)?.textContent?.trim();
  return text === undefined || text === '' ? undefined : text;
}

/** The common name of a base64 DER certificate, when it parses and has one. */
function commonNameOfBase64(value: string): string | undefined {
  try {
    const der = forge.util.createBuffer(Buffer.from(value.replace(/\s+/g, ''), 'base64').toString('binary'));
    return commonNameOf(forge.pki.certificateFromAsn1(forge.asn1.fromDer(der)));
  } catch {
    return undefined;
  }
}

/** What an `xenc:EncryptedData` hides, named from where it sits. */
function encryptedTarget(data: Element): string {
  const parent = data.parentNode as Element | null;
  const parentName = parent?.localName ?? 'document';
  const type = data.getAttribute('Type') ?? '';
  if (type.endsWith('#Content')) return `${parentName} (content)`;
  if (type.endsWith('#Element')) return `element in ${parentName}`;
  return parentName;
}

/** A step for an `xenc:EncryptedKey` or a standalone `xenc:ReferenceList`. */
function encryptionStep(element: Element, ids: ReadonlyMap<string, Element>): Step {
  const list = element.localName === 'ReferenceList' ? element : childElement(element, NS.XENC, 'ReferenceList');
  const data = (list === undefined ? [] : elementChildren(list))
    .filter((reference) => reference.localName === 'DataReference')
    .map((reference) => {
      const uri = reference.getAttribute('URI') ?? '';
      return uri.startsWith('#') ? ids.get(uri.slice(1)) : undefined;
    })
    .filter((found): found is Element => found !== undefined);
  const covers = data.map(encryptedTarget);
  const algorithms: string[] = [];
  const dataMethod = data[0] === undefined ? undefined : childElement(data[0], NS.XENC, 'EncryptionMethod');
  if (dataMethod !== undefined) algorithms.push(fragment(dataMethod.getAttribute('Algorithm') ?? ''));
  if (element.localName === 'EncryptedKey') {
    const transport = childElement(element, NS.XENC, 'EncryptionMethod')?.getAttribute('Algorithm') ?? '';
    if (transport !== '') algorithms.push(`key ${fragment(transport)}`);
  }
  const what = covers.length === 0 ? 'nothing this message names' : covers.join(', ');
  const id = idOf(element);
  return {
    kind: 'encryption',
    summary: `Encrypted ${what}${algorithms.length === 0 ? '' : ` (${algorithms.join(', ')})`}`,
    covers,
    ...(id !== undefined ? { id } : {}),
  };
}

/** A step for a `ds:Signature`. */
function signatureStep(signature: Element, ids: ReadonlyMap<string, Element>): Step {
  const signedInfo = childElement(signature, NS.DS, 'SignedInfo');
  const covers = (signedInfo === undefined ? [] : elementChildren(signedInfo))
    .filter((child) => child.namespaceURI === NS.DS && child.localName === 'Reference')
    .map((reference) => {
      const uri = reference.getAttribute('URI') ?? '';
      if (uri === '') return 'the whole message';
      const id = uri.startsWith('#') ? uri.slice(1) : uri;
      return ids.get(id)?.localName ?? `#${id}`;
    });
  const algorithms =
    signedInfo === undefined
      ? []
      : [childElement(signedInfo, NS.DS, 'SignatureMethod'), childElement(signedInfo, NS.DS, 'CanonicalizationMethod')]
          .filter((found): found is Element => found !== undefined)
          .map((found) => algorithmName(found.getAttribute('Algorithm') ?? undefined));
  const id = idOf(signature);
  const what = covers.length === 0 ? 'nothing' : covers.join(', ');
  return {
    kind: 'signature',
    summary: `Signed ${what}${algorithms.length === 0 ? '' : ` (${algorithms.join(', ')})`}`,
    covers,
    ...(id !== undefined ? { id } : {}),
  };
}

/** A step for a `wsse:BinarySecurityToken`. */
function binaryTokenStep(element: Element, withId: { readonly id?: string }): Step {
  const valueType = element.getAttribute('ValueType') ?? '';
  if (valueType === WSS_TOKEN_TYPES.X509V3) {
    const cn = commonNameOfBase64(element.textContent ?? '');
    return { kind: 'token', summary: `X.509 certificate${cn !== undefined ? ` (${cn})` : ''}`, ...withId };
  }
  if (valueType === WSS_TOKEN_TYPES.X509_PKI_PATH_V1) {
    return { kind: 'token', summary: 'X.509 certificate path', ...withId };
  }
  const type = valueType === '' ? 'unknown type' : fragment(valueType);
  return { kind: 'token', summary: `Binary security token (${type})`, ...withId };
}

/** The step one `wsse:Security` child stands for. */
function stepOf(element: Element, ids: ReadonlyMap<string, Element>): Step {
  const namespace = element.namespaceURI;
  const name = element.localName ?? '';
  const id = idOf(element);
  const withId = id !== undefined ? { id } : {};
  if (namespace === NS.WSU && name === 'Timestamp') {
    const created = childText(element, NS.WSU, 'Created');
    const expires = childText(element, NS.WSU, 'Expires');
    const times = [
      ...(created !== undefined ? [`created ${created}`] : []),
      ...(expires !== undefined ? [`expires ${expires}`] : []),
    ];
    return {
      kind: 'timestamp',
      summary: times.length === 0 ? 'Timestamp' : `Timestamp (${times.join(', ')})`,
      ...withId,
    };
  }
  if (namespace === NS.WSSE && name === 'UsernameToken') {
    // The username and password are the user's own data; the timeline names only the form.
    const password = childElement(element, NS.WSSE, 'Password');
    const type = password === undefined ? 'no password' : fragment(password.getAttribute('Type') ?? '#PasswordText');
    return { kind: 'username-token', summary: `UsernameToken (${type})`, ...withId };
  }
  if (namespace === NS.WSSE && name === 'BinarySecurityToken') return binaryTokenStep(element, withId);
  if ((namespace === NS.SAML1 || namespace === NS.SAML2) && name === 'Assertion') {
    const assertionId = element.getAttribute('ID') ?? element.getAttribute('AssertionID') ?? '';
    return {
      kind: 'token',
      summary: `SAML ${namespace === NS.SAML2 ? '2.0' : '1.1'} assertion`,
      ...(assertionId !== '' ? { id: assertionId } : withId),
    };
  }
  if (namespace === NS.DS && name === 'Signature') return signatureStep(element, ids);
  if (namespace === NS.XENC && (name === 'EncryptedKey' || name === 'ReferenceList')) {
    return encryptionStep(element, ids);
  }
  if (namespace === NS.XENC && name === 'EncryptedData') {
    return { kind: 'encryption', summary: 'An encrypted header element', ...withId };
  }
  if (namespace === NS.WSSE && name === 'SecurityTokenReference') {
    return { kind: 'other', summary: 'Security token reference', ...withId };
  }
  return { kind: 'other', summary: name, ...withId };
}

/**
 * The timeline of every `wsse:Security` header in `xml`, in header order.
 *
 * Never throws: a message that does not parse, is not a SOAP envelope or carries no
 * `wsse:Security` header has an empty timeline.
 *
 * @param xml a SOAP envelope, as sent or as it arrived
 * @returns one step per `wsse:Security` child
 */
export function describeSecurityHeader(xml: string): WssTimelineStep[] {
  let root: Element | null;
  try {
    root = parseXml(xml, { location: 'envelope' }).documentElement;
  } catch {
    return [];
  }
  if (root === null) return [];
  const envelopeNs = root.namespaceURI;
  if (envelopeNs !== NS.SOAP11_ENV && envelopeNs !== NS.SOAP12_ENV) return [];
  const header = childElement(root, envelopeNs, 'Header');
  if (header === undefined) return [];
  const actorName = envelopeNs === NS.SOAP12_ENV ? 'role' : 'actor';
  const ids = idIndex(root);
  const steps: WssTimelineStep[] = [];
  for (const security of securityHeaders(header)) {
    const actor = security.getAttributeNS(envelopeNs, actorName);
    for (const child of elementChildren(security)) {
      steps.push({ ...stepOf(child, ids), ...(actor !== null && actor !== '' ? { actor } : {}) });
    }
  }
  return steps;
}
