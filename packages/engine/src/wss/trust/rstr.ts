/**
 * Reads a WS-Trust response (1.3 `RequestSecurityTokenResponseCollection` or a single
 * `RequestSecurityTokenResponse`, either version): the token, its attached reference and its
 * lifetime. The token is serialised on its own, so it carries every namespace it needs.
 */
import type { Element } from '@xmldom/xmldom';
import { WssError } from '../../errors.js';
import { parseXml } from '../../xml/parse.js';
import { serializeXml } from '../../xml/serialize.js';
import { NS } from '../../xml/namespaces.js';
import { parseFault } from '../../soap/fault.js';
import { readAssertion } from '../saml/read.js';
import type { SamlVersion } from '../model.js';

export interface ParsedRstr {
  readonly assertionXml: string;
  readonly assertionId?: string;
  readonly attachedReferenceXml?: string;
  readonly samlVersion: SamlVersion;
  readonly expiresAt?: Date;
}

const TRUST_NAMESPACES: readonly string[] = [NS.WST13, NS.WST2005];

function trustChild(parent: Element, localName: string): Element | undefined {
  for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
    const element = node as Element;
    if (
      node.nodeType === 1 &&
      element.localName === localName &&
      TRUST_NAMESPACES.includes(element.namespaceURI ?? '')
    ) {
      return element;
    }
  }
  return undefined;
}

function firstTrust(root: Element, localName: string): Element | undefined {
  for (const namespace of TRUST_NAMESPACES) {
    const found = root.getElementsByTagNameNS(namespace, localName).item(0);
    if (found !== null) return found;
  }
  return undefined;
}

function onlyElementChild(parent: Element): Element | undefined {
  let found: Element | undefined;
  for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType === 1) {
      if (found !== undefined) return undefined;
      found = node as Element;
    }
  }
  return found;
}

function invalid(reason: string): WssError {
  return new WssError('ws-trust-response-invalid', `The token service's answer is not a token: ${reason}.`);
}

function dateOf(text: string | null | undefined): Date | undefined {
  if (text === null || text === undefined || text.trim() === '') return undefined;
  const date = new Date(text.trim());
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** @throws WssError `ws-trust-sts-fault` | `ws-trust-response-invalid` | `ws-trust-symmetric-key-unsupported` */
export function parseRstr(body: string, status: number): ParsedRstr {
  let doc;
  try {
    doc = parseXml(body, { location: 'ws-trust' });
  } catch {
    throw new WssError(
      'ws-trust-sts-fault',
      `The token service answered ${String(status)} with a body that is not XML.`,
      { details: { status } },
    );
  }
  const fault = parseFault(doc);
  if (fault !== undefined || status < 200 || status >= 300) {
    throw new WssError(
      'ws-trust-sts-fault',
      fault !== undefined
        ? `The token service refused: ${fault.reason}`
        : `The token service answered ${String(status)}.`,
      {
        details: {
          status,
          ...(fault !== undefined ? { faultCode: fault.code, subcodes: fault.subcodes, reason: fault.reason } : {}),
        },
      },
    );
  }
  const root = doc.documentElement;
  if (root === null) throw invalid('it is empty');
  const response = firstTrust(root, 'RequestSecurityTokenResponse');
  if (response === undefined) throw invalid('it has no RequestSecurityTokenResponse');
  if (trustChild(response, 'RequestedProofToken') !== undefined) {
    throw new WssError(
      'ws-trust-symmetric-key-unsupported',
      'The token service issued a symmetric proof key; only bearer and public-key tokens are supported.',
    );
  }
  const requested = trustChild(response, 'RequestedSecurityToken');
  const tokenElement = requested === undefined ? undefined : onlyElementChild(requested);
  if (tokenElement === undefined) throw invalid('RequestedSecurityToken does not hold exactly one token');
  const assertionXml = serializeXml(tokenElement);
  const read = readAssertion(assertionXml);
  const attached = trustChild(response, 'RequestedAttachedReference');
  const attachedStr = attached === undefined ? undefined : onlyElementChild(attached);
  const lifetime = trustChild(response, 'Lifetime');
  const expires = lifetime?.getElementsByTagNameNS(NS.WSU, 'Expires').item(0)?.textContent;
  const conditions = read.element
    .getElementsByTagNameNS(read.version === '2.0' ? NS.SAML2 : NS.SAML1, 'Conditions')
    .item(0);
  const expiresAt = dateOf(expires) ?? dateOf(conditions?.getAttribute('NotOnOrAfter'));
  return {
    assertionXml,
    ...(read.id !== undefined ? { assertionId: read.id } : {}),
    ...(attachedStr !== undefined ? { attachedReferenceXml: serializeXml(attachedStr) } : {}),
    samlVersion: read.version,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}
