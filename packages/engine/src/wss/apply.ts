/**
 * Applies (and removes) an outgoing WS-Security header on a SOAP envelope: the
 * `wsse:Security` block, its `mustUnderstand`/actor attributes, and the configured entries in
 * configuration order.
 */

import type { Document, Element } from '@xmldom/xmldom';
import { WssError } from '../errors.js';
import { parseXml } from '../xml/parse.js';
import { serializeXml } from '../xml/serialize.js';
import { NS } from '../xml/namespaces.js';
import { detectEnvelopeVersion, envelopeNamespace } from '../soap/envelope.js';
import type { SoapEnvelopeVersion } from '../soap/envelope.js';
import { buildTimestamp } from './outgoing/timestamp.js';
import { buildUsernameToken } from './outgoing/username-token.js';
import type { WssContext, WssEntry, WssOutgoingConfig, WssPasswordType } from './model.js';

/** The namespace `xmlns:*` declarations themselves live in. */
const XMLNS = 'http://www.w3.org/2000/xmlns/';

/** Request-level properties that override an entry's own settings for one send. */
export interface WssRequestProperties {
  readonly wssPasswordType?: 'text' | 'digest';
  readonly wssTimeToLive?: number;
}

/** Options accepted by {@link applyOutgoingWss}. */
export interface ApplyOutgoingWssOptions {
  readonly requestProperties?: WssRequestProperties;
}

/** The attribute name carrying the SOAP actor/role for `version`. */
function actorAttribute(version: SoapEnvelopeVersion): string {
  return version === '1.2' ? 'role' : 'actor';
}

/** The `mustUnderstand` value `version` expects. */
function mustUnderstandValue(version: SoapEnvelopeVersion): string {
  return version === '1.2' ? 'true' : '1';
}

/** The first child element of `parent` in `namespace` with local name `localName`. */
function childElement(parent: Element, namespace: string, localName: string): Element | undefined {
  for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
    const element = node as Element;
    if (element.nodeType === 1 && element.namespaceURI === namespace && element.localName === localName) {
      return element;
    }
  }
  return undefined;
}

/** Every `wsse:Security` header block in `header`. */
function securityHeaders(header: Element): Element[] {
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
function securityActor(security: Element, version: SoapEnvelopeVersion): string | undefined {
  const value = security.getAttributeNS(envelopeNamespace(version), actorAttribute(version));
  return value === null || value === '' ? undefined : value;
}

/** Parses `envelopeXml`, rejecting anything that is not a SOAP envelope. */
function parseEnvelope(envelopeXml: string): { doc: Document; root: Element; version: SoapEnvelopeVersion } {
  const doc = parseXml(envelopeXml, { location: 'envelope' });
  const version = detectEnvelopeVersion(doc);
  const root = doc.documentElement;
  if (version === undefined || root === null) {
    throw new WssError('wss-not-an-envelope', 'WS-Security can only be applied to a SOAP envelope.');
  }
  return { doc, root, version };
}

/** The prefix the envelope binds its SOAP namespace to (`soapenv` when it uses a default namespace). */
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
  const body = childElement(root, namespace, 'Body');
  root.insertBefore(header, body ?? null);
  return header;
}

/** Finds or creates the `wsse:Security` block addressed to `actor`. */
function ensureSecurity(
  doc: Document,
  root: Element,
  header: Element,
  version: SoapEnvelopeVersion,
  config: WssOutgoingConfig,
): Element {
  const existing = securityHeaders(header).find((element) => securityActor(element, version) === config.actor);
  const security = existing ?? doc.createElementNS(NS.WSSE, 'wsse:Security');
  if (existing === undefined) {
    // `wsse` comes from the element's own name; `wsu` is declared here through the xmlns
    // namespace (not as a plain attribute) so xmldom records it in the element's namespace map
    // and the entries below inherit the prefix instead of re-declaring it on every child.
    security.setAttributeNS(XMLNS, 'xmlns:wsu', NS.WSU);
    header.appendChild(security);
  }
  const prefix = envelopePrefix(root);
  if (config.actor !== undefined && config.actor !== '') {
    security.setAttributeNS(envelopeNamespace(version), `${prefix}:${actorAttribute(version)}`, config.actor);
  }
  if (config.mustUnderstand) {
    security.setAttributeNS(envelopeNamespace(version), `${prefix}:mustUnderstand`, mustUnderstandValue(version));
  }
  return security;
}

/** The password type an entry effectively uses, after the request-level override. */
function effectivePasswordType(
  entry: { readonly passwordType: WssPasswordType },
  override?: 'text' | 'digest',
): WssPasswordType {
  // 'none' is a deliberate "send no password"; a request property never turns it back on.
  return entry.passwordType === 'none' ? 'none' : (override ?? entry.passwordType);
}

/** Builds the element for one entry, resolving its secret through `ctx`. */
async function buildEntry(
  entry: WssEntry,
  config: WssOutgoingConfig,
  ctx: WssContext,
  properties: WssRequestProperties | undefined,
): Promise<Element> {
  if (entry.kind === 'timestamp') {
    return buildTimestamp({
      ttlSeconds: properties?.wssTimeToLive ?? entry.timeToLiveSeconds,
      millisecondPrecision: entry.millisecondPrecision,
      clock: ctx.clock,
      uuid: ctx.uuid,
    });
  }
  if (entry.kind === 'username-token') {
    const passwordType = effectivePasswordType(entry, properties?.wssPasswordType);
    const ref = entry.passwordRef ?? config.defaultPasswordRef;
    const password = passwordType === 'none' || ref === undefined ? undefined : await ctx.secrets(ref);
    return buildUsernameToken({
      username: entry.username,
      ...(password !== undefined ? { password } : {}),
      passwordType,
      addNonce: entry.addNonce,
      addCreated: entry.addCreated,
      clock: ctx.clock,
      nonce: ctx.nonce,
      uuid: ctx.uuid,
    });
  }
  throw new WssError('wss-entry-unsupported', `WS-Security "${entry.kind}" entries are not supported yet.`, {
    details: { kind: entry.kind },
  });
}

/**
 * Applies `config` to `envelopeXml`, returning the new envelope.
 *
 * The `soap:Header` is created (before the `Body`) when missing, the `wsse:Security` block
 * addressed to `config.actor` is reused when one already exists, and the entries are appended
 * to it in configuration order. Request-level `wssPasswordType`/`wssTimeToLive` override the
 * matching entry fields for this application only.
 *
 * @param envelopeXml the envelope to secure
 * @param config the outgoing configuration
 * @param ctx the injected keystore/secret/clock/entropy capabilities
 * @param options request-level property overrides
 * @returns the serialized, secured envelope
 * @throws WssError `wss-not-an-envelope`, or `wss-entry-unsupported` for a signature/encryption entry
 */
export async function applyOutgoingWss(
  envelopeXml: string,
  config: WssOutgoingConfig,
  ctx: WssContext,
  options?: ApplyOutgoingWssOptions,
): Promise<string> {
  const { doc, root, version } = parseEnvelope(envelopeXml);
  const header = ensureHeader(doc, root, version);
  const security = ensureSecurity(doc, root, header, version, config);
  for (const entry of config.entries) {
    const element = await buildEntry(entry, config, ctx, options?.requestProperties);
    security.appendChild(doc.importNode(element, true));
  }
  return serializeXml(doc);
}

/**
 * Removes the `wsse:Security` header addressed to `actor` (the ultimate receiver's when
 * `actor` is omitted), plus the `soap:Header` if that emptied it.
 *
 * @param envelopeXml the envelope to clean
 * @param actor the actor/role whose Security block to remove
 * @returns the envelope without that header; unchanged when there is nothing to remove
 */
export function removeOutgoingWss(envelopeXml: string, actor?: string): string {
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
  let removed = false;
  for (const security of securityHeaders(header)) {
    if (securityActor(security, version) === actor) {
      header.removeChild(security);
      removed = true;
    }
  }
  if (!removed) {
    return envelopeXml;
  }
  if (childElement(header, NS.WSSE, 'Security') === undefined && header.firstChild === null) {
    root.removeChild(header);
  }
  return serializeXml(doc);
}
