/**
 * The `<ds:KeyInfo>` content an outgoing signature carries: a `wsse:SecurityTokenReference`
 * (or a bare `ds:X509Data`) pointing at the signing certificate in one of the five forms the
 * X.509 token profile defines.
 *
 * These are produced as XML *strings* rather than DOM nodes because `xml-crypto` builds the
 * whole `<ds:Signature>` element by string concatenation and asks for the KeyInfo contents the
 * same way. Every element therefore declares the prefixes it uses on itself.
 */

import { createHash } from 'node:crypto';
import forge from 'node-forge';
import { WssError } from '../errors.js';
import { NS } from '../xml/namespaces.js';
import { parseXml } from '../xml/parse.js';
import { serializeXml } from '../xml/serialize.js';
import { renderDnRfc2253 } from '../keystore/certificate.js';
import { SAML_KEY_IDENTIFIER_VALUE_TYPE, SAML_TOKEN_TYPE } from './saml/uris.js';
import type { Element } from '@xmldom/xmldom';
import type { PlacedSamlToken } from './outgoing/saml.js';
import type { WssKeyIdentifierType } from './model.js';

/** `ValueType`/`EncodingType` URIs from the WS-Security X.509 token profile. */
export const WSS_TOKEN_TYPES = {
  /** A single DER-encoded certificate. */
  X509V3: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3',
  /** An ordered DER PKIPath of certificates. */
  X509_PKI_PATH_V1: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509PKIPathv1',
  /** The certificate's subject key identifier extension value. */
  X509_SUBJECT_KEY_IDENTIFIER:
    'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509SubjectKeyIdentifier',
  /** SHA-1 of the DER encoding of the certificate. */
  THUMBPRINT_SHA1: 'http://docs.oasis-open.org/wss/oasis-wss-soap-message-security-1.1#ThumbprintSHA1',
  /** Base64 content encoding. */
  BASE64_BINARY: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary',
} as const;

/** What every key-identifier builder needs about the signing certificate. */
export interface KeyIdentifierInput {
  /** The signing (leaf) certificate, PEM encoded. */
  readonly certPem: string;
  /** The issuing chain, nearest first; only used for `X509PKIPathv1`. */
  readonly chainPem: readonly string[];
  /** Emit only the leaf rather than the whole path. */
  readonly useSingleCertificate: boolean;
  /** The `wsu:Id` a `BinarySecurityToken` gets (and the `wsse:Reference` points at). */
  readonly tokenId: string;
}

/** The KeyInfo content plus, for `BinarySecurityToken`, the token that must precede the signature. */
export interface KeyIdentifier {
  /** The XML that goes inside `<ds:KeyInfo>`. */
  readonly keyInfoXml: string;
  /** The `<wsse:BinarySecurityToken>` to insert into `wsse:Security`, when this form needs one. */
  readonly binarySecurityTokenXml?: string;
}

/** Escapes the five XML significant characters in attribute/text content. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The DER bytes of a PEM certificate. */
export function certificateDer(certPem: string): Buffer {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(certPem))).getBytes();
  return Buffer.from(der, 'binary');
}

/** Base64 of the DER encoding of `certPem`, unwrapped (one line). */
export function certificateBase64(certPem: string): string {
  return certificateDer(certPem).toString('base64');
}

/**
 * Base64 of the DER `PKIPath` (an ASN.1 SEQUENCE OF Certificate) holding the leaf and its chain.
 *
 * @param certPems the certificates, leaf first
 * @returns the base64 the `X509PKIPathv1` value type expects
 */
export function pkiPathBase64(certPems: readonly string[]): string {
  const certificates = certPems.map((pem) => forge.pki.certificateToAsn1(forge.pki.certificateFromPem(pem)));
  const sequence = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, certificates);
  return Buffer.from(forge.asn1.toDer(sequence).getBytes(), 'binary').toString('base64');
}

/** SHA-1 of the certificate's DER encoding, base64 encoded (the `ThumbprintSHA1` value). */
export function thumbprintSha1Base64(certPem: string): string {
  return createHash('sha1').update(certificateDer(certPem)).digest('base64');
}

/**
 * The certificate's subject key identifier extension value, base64 encoded.
 *
 * @param certPem the certificate to read
 * @returns the base64 `X509SubjectKeyIdentifier` value
 * @throws WssError `wss-ski-missing` when the certificate carries no such extension
 */
export function subjectKeyIdentifierBase64(certPem: string): string {
  const cert = forge.pki.certificateFromPem(certPem);
  const extension = cert.extensions.find(
    (candidate: { name?: string; id?: string }) =>
      candidate.name === 'subjectKeyIdentifier' || candidate.id === '2.5.29.14',
  ) as { subjectKeyIdentifier?: string; value?: string } | undefined;
  const hex = extension?.subjectKeyIdentifier;
  if (typeof hex !== 'string' || hex.length === 0) {
    throw new WssError(
      'wss-ski-missing',
      'The signing certificate has no Subject Key Identifier extension; choose another key identifier type.',
    );
  }
  return Buffer.from(hex, 'hex').toString('base64');
}

/** The certificate's issuer as an RFC 2253 distinguished name (most specific attribute first). */
export function issuerDnRfc2253(certPem: string): string {
  const cert = forge.pki.certificateFromPem(certPem);
  return renderDnRfc2253(cert.issuer.attributes);
}

/** The certificate's serial number in decimal, as `ds:X509SerialNumber` requires. */
export function serialNumberDecimal(certPem: string): string {
  const cert = forge.pki.certificateFromPem(certPem);
  return BigInt(`0x${cert.serialNumber}`).toString(10);
}

/** Opens a `wsse:SecurityTokenReference`, declaring both WS-Security prefixes on itself. */
function securityTokenReference(inner: string): string {
  return `<wsse:SecurityTokenReference xmlns:wsse="${NS.WSSE}" xmlns:wsu="${NS.WSU}">${inner}</wsse:SecurityTokenReference>`;
}

/** A `<wsse:KeyIdentifier>` carrying base64 content of the given value type. */
function keyIdentifierElement(valueType: string, value: string): string {
  return (
    `<wsse:KeyIdentifier ValueType="${valueType}" EncodingType="${WSS_TOKEN_TYPES.BASE64_BINARY}">` +
    `${value}</wsse:KeyIdentifier>`
  );
}

/**
 * Parses `referenceXml` and returns its root.
 *
 * @throws WssError `wss-saml-token-missing` when the root is not a `wsse:SecurityTokenReference`
 */
function assertSecurityTokenReference(referenceXml: string): Element {
  const root = parseXml(referenceXml, { location: 'envelope' }).documentElement;
  if (root === null || root.namespaceURI !== NS.WSSE || root.localName !== 'SecurityTokenReference') {
    throw new WssError(
      'wss-saml-token-missing',
      "The token service's attached reference is not a wsse:SecurityTokenReference.",
    );
  }
  return root;
}

/**
 * `referenceXml` (a token service's attached reference) with its root `wsu:Id` set to `id`.
 *
 * Parsed rather than patched as text, so leading whitespace or comments, an existing `wsu:Id`
 * (replaced: each copy of the reference in one message needs its own id) or an existing
 * `xmlns:wsu` binding never produce a duplicate attribute.
 *
 * @throws WssError `wss-saml-token-missing` when the reference is not a `wsse:SecurityTokenReference`
 */
function withWsuId(referenceXml: string, id: string): string {
  const root = assertSecurityTokenReference(referenceXml);
  // Reuse a prefix already bound to WS-Utility; never rebind a `wsu` the reference uses for something else.
  const prefix = root.lookupPrefix(NS.WSU) ?? (root.lookupNamespaceURI('wsu') === null ? 'wsu' : 'wsu0');
  if (root.lookupNamespaceURI(prefix) !== NS.WSU) {
    root.setAttributeNS('http://www.w3.org/2000/xmlns/', `xmlns:${prefix}`, NS.WSU);
  }
  root.setAttributeNS(NS.WSU, `${prefix}:Id`, id);
  return serializeXml(root);
}

/**
 * A `wsse:SecurityTokenReference` to a SAML token placed earlier in the same header: the RSTR's
 * own attached reference when it gave one, else a `KeyIdentifier` naming the assertion's id
 * (WSS SAML token profile 1.1 §3.4) with the `wsse11:TokenType` that profile requires.
 *
 * @throws WssError `wss-saml-token-missing` for a token with neither (an encrypted assertion
 * whose service sent no reference)
 */
export function samlTokenReference(token: PlacedSamlToken, options: { readonly id?: string } = {}): string {
  if (token.attachedReferenceXml !== undefined) {
    // withWsuId parses and checks the root; without an id the text is used as given, so check it here too.
    if (options.id === undefined) {
      assertSecurityTokenReference(token.attachedReferenceXml);
      return token.attachedReferenceXml;
    }
    return withWsuId(token.attachedReferenceXml, options.id);
  }
  if (token.assertionId === undefined) {
    throw new WssError(
      'wss-saml-token-missing',
      'The SAML token has no id to refer to; an encrypted assertion needs the token service to send a reference.',
    );
  }
  const idAttribute = options.id !== undefined ? ` wsu:Id="${escapeXml(options.id)}"` : '';
  return (
    `<wsse:SecurityTokenReference xmlns:wsse="${NS.WSSE}" xmlns:wsu="${NS.WSU}" xmlns:wsse11="${NS.WSSE11}"` +
    `${idAttribute} wsse11:TokenType="${SAML_TOKEN_TYPE[token.version]}">` +
    `<wsse:KeyIdentifier ValueType="${SAML_KEY_IDENTIFIER_VALUE_TYPE[token.version]}">${escapeXml(token.assertionId)}</wsse:KeyIdentifier>` +
    `</wsse:SecurityTokenReference>`
  );
}

/**
 * Builds the `ds:KeyInfo` content (and any `wsse:BinarySecurityToken`) for one key identifier
 * form.
 *
 * @param type which of the five X.509 token profile forms to emit
 * @param input the signing certificate, its chain and the token id to use
 * @returns the KeyInfo XML, plus the binary security token when the form needs one
 * @throws WssError `wss-ski-missing` for `SubjectKeyIdentifier` on a certificate without one,
 * `wss-saml-token-missing` for `saml-token` (built by `samlTokenReference` instead)
 */
export function buildKeyIdentifier(type: WssKeyIdentifierType, input: KeyIdentifierInput): KeyIdentifier {
  switch (type) {
    case 'BinarySecurityToken': {
      const valueType = input.useSingleCertificate ? WSS_TOKEN_TYPES.X509V3 : WSS_TOKEN_TYPES.X509_PKI_PATH_V1;
      const value = input.useSingleCertificate
        ? certificateBase64(input.certPem)
        : pkiPathBase64([input.certPem, ...input.chainPem]);
      return {
        keyInfoXml: securityTokenReference(`<wsse:Reference URI="#${input.tokenId}" ValueType="${valueType}"/>`),
        binarySecurityTokenXml:
          `<wsse:BinarySecurityToken xmlns:wsse="${NS.WSSE}" xmlns:wsu="${NS.WSU}" ` +
          `wsu:Id="${input.tokenId}" EncodingType="${WSS_TOKEN_TYPES.BASE64_BINARY}" ` +
          `ValueType="${valueType}">${value}</wsse:BinarySecurityToken>`,
      };
    }
    case 'IssuerSerial':
      return {
        keyInfoXml:
          `<ds:X509Data xmlns:ds="${NS.DS}"><ds:X509IssuerSerial>` +
          `<ds:X509IssuerName>${escapeXml(issuerDnRfc2253(input.certPem))}</ds:X509IssuerName>` +
          `<ds:X509SerialNumber>${serialNumberDecimal(input.certPem)}</ds:X509SerialNumber>` +
          `</ds:X509IssuerSerial></ds:X509Data>`,
      };
    case 'SubjectKeyIdentifier':
      return {
        keyInfoXml: securityTokenReference(
          keyIdentifierElement(WSS_TOKEN_TYPES.X509_SUBJECT_KEY_IDENTIFIER, subjectKeyIdentifierBase64(input.certPem)),
        ),
      };
    case 'X509KeyIdentifier':
      return {
        keyInfoXml: securityTokenReference(
          keyIdentifierElement(WSS_TOKEN_TYPES.X509V3, certificateBase64(input.certPem)),
        ),
      };
    case 'Thumbprint':
      return {
        keyInfoXml: securityTokenReference(
          keyIdentifierElement(WSS_TOKEN_TYPES.THUMBPRINT_SHA1, thumbprintSha1Base64(input.certPem)),
        ),
      };
    case 'saml-token':
      // signEnvelope builds this form itself from the placed tokens; it never reaches here.
      throw new WssError('wss-saml-token-missing', 'A SAML token reference needs the token it refers to.');
  }
}
