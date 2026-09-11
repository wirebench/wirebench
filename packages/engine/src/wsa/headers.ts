/**
 * Builds, applies and strips the WS-Addressing header block of an outgoing SOAP envelope,
 * for both the 2005/08 (W3C Recommendation) and the 2004/08 (Member Submission) versions.
 *
 * Header construction is deterministic: every non-deterministic input — the MessageID's UUID —
 * is injected, so a golden test can pin the exact bytes.
 */

import type { Document, Element } from '@xmldom/xmldom';
import { WsaError } from '../errors.js';
import { detectEnvelopeVersion, envelopeNamespace } from '../soap/envelope.js';
import type { SoapEnvelopeVersion } from '../soap/envelope.js';
import { NS } from '../xml/namespaces.js';
import { parseXml } from '../xml/parse.js';
import { serializeXml } from '../xml/serialize.js';
import type { WsaConfig, WsaVersion } from './model.js';

/** The prefix every generated WS-Addressing header binds its namespace to. */
export const WSA_PREFIX = 'wsa';

/** The addressing namespace URI for `version`. */
export function wsaNamespace(version: WsaVersion): string {
  return version === '2004/08' ? NS.WSA_200408 : NS.WSA_200508;
}

/** The "anonymous" endpoint-reference address for `version`. */
export function anonymousAddress(version: WsaVersion): string {
  return version === '2004/08'
    ? 'http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous'
    : 'http://www.w3.org/2005/08/addressing/anonymous';
}

/** The default `RelationshipType` of a `wsa:RelatesTo` for `version`. */
export function defaultRelationshipType(version: WsaVersion): string {
  return version === '2004/08' ? 'wsa:Reply' : 'http://www.w3.org/2005/08/addressing/reply';
}

/** Everything a header block needs that the configuration itself does not carry. */
export interface WsaHeaderContext {
  /** The URL the request is about to be sent to; the default `wsa:To`. */
  readonly endpoint: string;
  /** The request's SOAPAction, used as the `wsa:Action` when the configuration names none. */
  readonly soapAction?: string;
  /** The WSDL-derived default action, used when neither the configuration nor SOAPAction says. */
  readonly defaultAction: string;
  /** Mints the MessageID's UUID; injected so golden tests are deterministic. */
  readonly uuid: () => string;
  readonly envelopeVersion: SoapEnvelopeVersion;
}

/** The `soap:mustUnderstand` attribute value meaning `true` for `version`. */
function mustUnderstandLiteral(version: SoapEnvelopeVersion, value: 'true' | 'false'): string {
  if (version === '1.2') {
    return value;
  }
  return value === 'true' ? '1' : '0';
}

/** The `wsa:Action` a send will carry, or `undefined` when it carries none. */
export function effectiveAction(
  config: WsaConfig,
  ctx: Pick<WsaHeaderContext, 'soapAction' | 'defaultAction'>,
): string | undefined {
  if (config.action !== undefined && config.action.length > 0) {
    return config.action;
  }
  if (!config.addDefaultAction) {
    return undefined;
  }
  if (ctx.soapAction !== undefined && ctx.soapAction.length > 0) {
    return ctx.soapAction;
  }
  return ctx.defaultAction.length > 0 ? ctx.defaultAction : undefined;
}

/** The `wsa:To` a send will carry, or `undefined` when it carries none. */
export function effectiveTo(config: WsaConfig, endpoint: string): string | undefined {
  if (config.to !== undefined && config.to.length > 0) {
    return config.to;
  }
  if (!config.addDefaultTo) {
    return undefined;
  }
  return endpoint.length > 0 ? endpoint : undefined;
}

/** The `wsa:MessageID` a send will carry, or `undefined` when it carries none. */
export function effectiveMessageId(config: WsaConfig, uuid: () => string): string | undefined {
  const configured = config.messageId;
  if (configured !== undefined && configured.length > 0 && configured !== 'auto') {
    return configured;
  }
  if (configured === 'auto' || config.generateMessageId) {
    return `urn:uuid:${uuid()}`;
  }
  return undefined;
}

/** Resolves an endpoint-reference address, mapping the literal `anonymous` to the version's URI. */
function addressOf(value: string, version: WsaVersion): string {
  return value === 'anonymous' ? anonymousAddress(version) : value;
}

/**
 * Builds the `wsa:*` header elements for `config`, in WS-Addressing's own order:
 * `Action`, `To`, `MessageID`, `ReplyTo`, `From`, `FaultTo`, `RelatesTo`.
 *
 * The elements belong to a scratch document; a caller inserting them into an envelope must
 * `importNode` them first (as {@link applyWsaHeaders} does).
 *
 * @param config the effective configuration for this send
 * @param ctx the endpoint, SOAPAction, WSDL default action, UUID source and SOAP version
 * @returns the header elements, empty when the configuration produces none
 */
export function buildWsaHeaders(config: WsaConfig, ctx: WsaHeaderContext): readonly Element[] {
  const ns = wsaNamespace(config.version);
  const doc = parseXml(`<wsa:headers xmlns:wsa="${ns}"/>`, { location: 'wsa-headers' });
  const owner = doc.documentElement;
  /* v8 ignore next 3 */
  if (owner === null) {
    return [];
  }
  const envelopeNs = envelopeNamespace(ctx.envelopeVersion);
  const headers: Element[] = [];

  const create = (localName: string): Element => {
    const element = doc.createElementNS(ns, `${WSA_PREFIX}:${localName}`);
    if (config.mustUnderstand !== 'none') {
      element.setAttributeNS(
        envelopeNs,
        `soapenv:mustUnderstand`,
        mustUnderstandLiteral(ctx.envelopeVersion, config.mustUnderstand),
      );
    }
    headers.push(element);
    return element;
  };
  const text = (localName: string, value: string): Element => {
    const element = create(localName);
    element.appendChild(doc.createTextNode(value));
    return element;
  };
  const epr = (localName: string, value: string): void => {
    const element = create(localName);
    const address = doc.createElementNS(ns, `${WSA_PREFIX}:Address`);
    address.appendChild(doc.createTextNode(addressOf(value, config.version)));
    element.appendChild(address);
  };

  const action = effectiveAction(config, ctx);
  if (action !== undefined) {
    text('Action', action);
  }
  const to = effectiveTo(config, ctx.endpoint);
  if (to !== undefined) {
    text('To', to);
  }
  const messageId = effectiveMessageId(config, ctx.uuid);
  if (messageId !== undefined) {
    text('MessageID', messageId);
  }
  for (const [field, localName] of [
    ['replyTo', 'ReplyTo'],
    ['from', 'From'],
    ['faultTo', 'FaultTo'],
  ] as const) {
    const value = config[field];
    if (value !== undefined && value.length > 0) {
      epr(localName, value);
    }
  }
  if (config.relatesTo !== undefined && config.relatesTo.length > 0) {
    const element = text('RelatesTo', config.relatesTo);
    const relationship = config.relationshipType;
    element.setAttribute(
      'RelationshipType',
      relationship !== undefined && relationship.length > 0 ? relationship : defaultRelationshipType(config.version),
    );
  }
  return headers;
}

/** Parses `envelopeXml`, rejecting anything that is not a SOAP envelope. */
function parseEnvelope(envelopeXml: string): { doc: Document; root: Element; version: SoapEnvelopeVersion } {
  const doc = parseXml(envelopeXml, { location: 'envelope' });
  const version = detectEnvelopeVersion(doc);
  const root = doc.documentElement;
  if (version === undefined || root === null) {
    throw new WsaError('wsa-not-an-envelope', 'WS-Addressing can only be applied to a SOAP envelope.');
  }
  return { doc, root, version };
}

/** The direct child element of `parent` in `namespaceUri` with `localName`, if any. */
function childElement(parent: Element, namespaceUri: string, localName: string): Element | undefined {
  for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType === 1) {
      const element = node as Element;
      if (element.namespaceURI === namespaceUri && element.localName === localName) {
        return element;
      }
    }
  }
  return undefined;
}

/** The prefix the envelope binds its SOAP namespace to (`soapenv` when it uses a default one). */
function envelopePrefix(root: Element): string {
  const prefix = root.prefix;
  return prefix === null || prefix === '' ? 'soapenv' : prefix;
}

/** Finds or creates the `soap:Header`, always placing a new one before the `Body`. */
function ensureHeader(doc: Document, root: Element, version: SoapEnvelopeVersion): Element {
  const namespace = envelopeNamespace(version);
  const existing = childElement(root, namespace, 'Header');
  if (existing !== undefined) {
    return existing;
  }
  const header = doc.createElementNS(namespace, `${envelopePrefix(root)}:Header`);
  root.insertBefore(header, childElement(root, namespace, 'Body') ?? null);
  return header;
}

/** Removes every `wsa:*` header of either version from `header`; returns how many went. */
function removeExisting(header: Element): number {
  const doomed: Element[] = [];
  for (let node = header.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType === 1) {
      const element = node as Element;
      if (element.namespaceURI === NS.WSA_200508 || element.namespaceURI === NS.WSA_200408) {
        doomed.push(element);
      }
    }
  }
  for (const element of doomed) {
    header.removeChild(element);
  }
  return doomed.length;
}

/**
 * Writes `config`'s WS-Addressing headers into `envelopeXml`.
 *
 * Any `wsa:*` header already present — of *either* version — is removed first, so applying
 * twice (or switching version) never leaves two contradicting `wsa:Action`s behind. The new
 * block is inserted before every other header, which is where a reader looks for it.
 *
 * @param envelopeXml the envelope to address
 * @param config the effective configuration for this send
 * @param ctx the endpoint, SOAPAction, default action, UUID source and SOAP version
 * @returns the serialized, addressed envelope
 * @throws WirebenchError `wsa-not-an-envelope` when `envelopeXml` is not a SOAP envelope
 */
export function applyWsaHeaders(envelopeXml: string, config: WsaConfig, ctx: WsaHeaderContext): string {
  const { doc, root, version } = parseEnvelope(envelopeXml);
  const header = ensureHeader(doc, root, version);
  removeExisting(header);
  const built = buildWsaHeaders(config, { ...ctx, envelopeVersion: version });
  const first = header.firstChild;
  for (const element of built) {
    header.insertBefore(doc.importNode(element, true), first);
  }
  return serializeXml(doc);
}

/**
 * Removes every WS-Addressing header (either version) from `envelopeXml`.
 *
 * A document that is not a SOAP envelope — or that carries no addressing at all — is returned
 * byte for byte, so "Remove" on an untouched envelope is a genuine no-op.
 *
 * @param envelopeXml the envelope to clean
 */
export function stripWsaHeaders(envelopeXml: string): string {
  let parsed;
  try {
    parsed = parseEnvelope(envelopeXml);
  } catch {
    return envelopeXml;
  }
  const { doc, root, version } = parsed;
  const header = childElement(root, envelopeNamespace(version), 'Header');
  if (header === undefined) {
    return envelopeXml;
  }
  return removeExisting(header) === 0 ? envelopeXml : serializeXml(doc);
}
