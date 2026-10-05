/**
 * Reads a SAML assertion supplied as text: which version it is, its id, and the holder-of-key
 * certificate it names. Parsed with the engine's hardened parser (no DTDs, no external entities).
 */
import type { Element } from '@xmldom/xmldom';
import { WssError } from '../../errors.js';
import { parseXml } from '../../xml/parse.js';
import { NS } from '../../xml/namespaces.js';
import type { SamlVersion } from '../model.js';

export interface ReadAssertion {
  readonly element: Element;
  readonly version: SamlVersion;
  /** `ID` (2.0) or `AssertionID` (1.1); absent when encrypted. */
  readonly id?: string;
  readonly encrypted: boolean;
  /** The `ds:X509Certificate` in a holder-of-key `SubjectConfirmation`, as PEM. */
  readonly holderOfKeyCertPem?: string;
}

function invalid(reason: string): WssError {
  return new WssError('saml-token-invalid', `The SAML token is not a usable assertion: ${reason}.`);
}

function firstDescendant(root: Element, namespace: string, localName: string): Element | undefined {
  const found = root.getElementsByTagNameNS(namespace, localName);
  return found.length > 0 ? (found.item(0) ?? undefined) : undefined;
}

function pemOf(base64: string): string {
  const body = base64.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${body.trimEnd()}\n-----END CERTIFICATE-----\n`;
}

/**
 * @throws WssError `saml-token-invalid` when the text does not parse or its root is not
 * `saml:Assertion`, `saml2:Assertion` or `saml2:EncryptedAssertion`
 */
export function readAssertion(xml: string): ReadAssertion {
  let root: Element | null;
  try {
    root = parseXml(xml, { location: 'saml-token' }).documentElement;
  } catch {
    throw invalid('it is not well-formed XML');
  }
  if (root === null) throw invalid('it is empty');
  if (root.namespaceURI === NS.SAML2 && root.localName === 'EncryptedAssertion') {
    return { element: root, version: '2.0', encrypted: true };
  }
  const version: SamlVersion | undefined =
    root.namespaceURI === NS.SAML2 && root.localName === 'Assertion'
      ? '2.0'
      : root.namespaceURI === NS.SAML1 && root.localName === 'Assertion'
        ? '1.1'
        : undefined;
  if (version === undefined) throw invalid(`its root is <${root.nodeName}>`);
  const id = root.getAttribute(version === '2.0' ? 'ID' : 'AssertionID') ?? '';
  const confirmation = firstDescendant(root, version === '2.0' ? NS.SAML2 : NS.SAML1, 'SubjectConfirmation');
  const certificate = confirmation === undefined ? undefined : firstDescendant(confirmation, NS.DS, 'X509Certificate');
  const certText = certificate?.textContent?.trim();
  return {
    element: root,
    version,
    ...(id !== '' ? { id } : {}),
    encrypted: false,
    ...(certText !== undefined && certText !== '' ? { holderOfKeyCertPem: pemOf(certText) } : {}),
  };
}
