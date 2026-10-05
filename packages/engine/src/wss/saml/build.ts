/**
 * Builds a self-issued SAML assertion from a form entry, as a self-contained string that
 * declares every prefix it uses on its root, optionally signed by its issuer (an enveloped
 * signature over `ID`/`AssertionID`, exc-c14n, RSA).
 */
import { SignedXml } from 'xml-crypto';
import { certificateBase64 } from '../key-identifiers.js';
import { privateKeyOf } from '../outgoing/signature.js';
import { NS } from '../../xml/namespaces.js';
import { SAML1_AUTHN_METHOD_UNSPECIFIED, SAML_AUTHN_CONTEXT_UNSPECIFIED, SAML_CONFIRMATION_METHOD } from './uris.js';
import { SAML_NOT_BEFORE_SKEW_SECONDS } from '../model.js';
import type { KeystoreAlias } from '../../keystore/model.js';
import type { WssSamlFormEntry } from '../model.js';

const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const SIGNATURE_URIS = {
  'rsa-sha256': 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  'rsa-sha1': 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
} as const;
const DIGEST_URIS = {
  'rsa-sha256': 'http://www.w3.org/2001/04/xmlenc#sha256',
  'rsa-sha1': 'http://www.w3.org/2000/09/xmldsig#sha1',
} as const;

export interface BuildSamlInput {
  readonly clock: () => Date;
  readonly uuid: () => string;
  readonly signing?: { readonly alias: KeystoreAlias; readonly passphrase?: string };
  readonly proofCertPem?: string;
}

/** Attribute value escaping. */
function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Text content escaping: `"` stays literal, as serializers write it. */
function text(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function keyInfo(certPem: string): string {
  return (
    `<ds:KeyInfo xmlns:ds="${NS.DS}"><ds:X509Data><ds:X509Certificate>${certificateBase64(certPem)}` +
    `</ds:X509Certificate></ds:X509Data></ds:KeyInfo>`
  );
}

function window(now: Date, lifetimeSeconds: number): { notBefore: string; notOnOrAfter: string } {
  return {
    notBefore: new Date(now.getTime() - SAML_NOT_BEFORE_SKEW_SECONDS * 1000).toISOString(),
    notOnOrAfter: new Date(now.getTime() + lifetimeSeconds * 1000).toISOString(),
  };
}

function saml2(entry: WssSamlFormEntry, id: string, now: Date, input: BuildSamlInput): string {
  const { notBefore, notOnOrAfter } = window(now, entry.lifetimeSeconds);
  const method = SAML_CONFIRMATION_METHOD['2.0'][entry.confirmation];
  const confirmationData =
    entry.confirmation === 'holder-of-key' && input.proofCertPem !== undefined
      ? `<saml2:SubjectConfirmationData xmlns:xsi="${NS.XSI}" xsi:type="saml2:KeyInfoConfirmationDataType">${keyInfo(input.proofCertPem)}</saml2:SubjectConfirmationData>`
      : `<saml2:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}"/>`;
  const format = entry.subjectFormat !== undefined ? ` Format="${esc(entry.subjectFormat)}"` : '';
  const audience =
    entry.audience !== undefined && entry.audience !== ''
      ? `<saml2:AudienceRestriction><saml2:Audience>${text(entry.audience)}</saml2:Audience></saml2:AudienceRestriction>`
      : '';
  const attributes =
    entry.attributes.length === 0
      ? ''
      : `<saml2:AttributeStatement>${entry.attributes
          .map(
            (attribute) =>
              `<saml2:Attribute Name="${esc(attribute.name)}"` +
              `${attribute.nameFormat !== undefined ? ` NameFormat="${esc(attribute.nameFormat)}"` : ''}>` +
              attribute.values.map((value) => `<saml2:AttributeValue>${text(value)}</saml2:AttributeValue>`).join('') +
              `</saml2:Attribute>`,
          )
          .join('')}</saml2:AttributeStatement>`;
  return (
    `<saml2:Assertion xmlns:saml2="${NS.SAML2}" ID="${id}" Version="2.0" IssueInstant="${now.toISOString()}">` +
    `<saml2:Issuer>${text(entry.issuer)}</saml2:Issuer>` +
    `<saml2:Subject><saml2:NameID${format}>${text(entry.subject)}</saml2:NameID>` +
    `<saml2:SubjectConfirmation Method="${method}">${confirmationData}</saml2:SubjectConfirmation></saml2:Subject>` +
    `<saml2:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">${audience}</saml2:Conditions>` +
    `<saml2:AuthnStatement AuthnInstant="${now.toISOString()}"><saml2:AuthnContext>` +
    `<saml2:AuthnContextClassRef>${text(entry.authnContext ?? SAML_AUTHN_CONTEXT_UNSPECIFIED)}</saml2:AuthnContextClassRef>` +
    `</saml2:AuthnContext></saml2:AuthnStatement>${attributes}</saml2:Assertion>`
  );
}

function saml1(entry: WssSamlFormEntry, id: string, now: Date, input: BuildSamlInput): string {
  const { notBefore, notOnOrAfter } = window(now, entry.lifetimeSeconds);
  const method = SAML_CONFIRMATION_METHOD['1.1'][entry.confirmation];
  const proof =
    entry.confirmation === 'holder-of-key' && input.proofCertPem !== undefined ? keyInfo(input.proofCertPem) : '';
  const format = entry.subjectFormat !== undefined ? ` Format="${esc(entry.subjectFormat)}"` : '';
  const subject =
    `<saml:Subject><saml:NameIdentifier${format}>${text(entry.subject)}</saml:NameIdentifier>` +
    `<saml:SubjectConfirmation><saml:ConfirmationMethod>${method}</saml:ConfirmationMethod>${proof}` +
    `</saml:SubjectConfirmation></saml:Subject>`;
  const audience =
    entry.audience !== undefined && entry.audience !== ''
      ? `<saml:AudienceRestrictionCondition><saml:Audience>${text(entry.audience)}</saml:Audience></saml:AudienceRestrictionCondition>`
      : '';
  const attributes =
    entry.attributes.length === 0
      ? ''
      : `<saml:AttributeStatement>${subject}${entry.attributes
          .map(
            (attribute) =>
              `<saml:Attribute AttributeName="${esc(attribute.name)}" AttributeNamespace="${esc(attribute.nameFormat ?? 'urn:wirebench:attributes')}">` +
              attribute.values.map((value) => `<saml:AttributeValue>${text(value)}</saml:AttributeValue>`).join('') +
              `</saml:Attribute>`,
          )
          .join('')}</saml:AttributeStatement>`;
  return (
    `<saml:Assertion xmlns:saml="${NS.SAML1}" MajorVersion="1" MinorVersion="1" AssertionID="${id}"` +
    ` Issuer="${esc(entry.issuer)}" IssueInstant="${now.toISOString()}">` +
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">${audience}</saml:Conditions>` +
    `<saml:AuthenticationStatement AuthenticationMethod="${esc(entry.authnContext ?? SAML1_AUTHN_METHOD_UNSPECIFIED)}"` +
    ` AuthenticationInstant="${now.toISOString()}">${subject}</saml:AuthenticationStatement>${attributes}</saml:Assertion>`
  );
}

/** The assertion `entry` describes, signed as its issuer when `entry.sign` and `input.signing` are both given. */
export function buildSamlAssertion(entry: WssSamlFormEntry, input: BuildSamlInput): string {
  const now = input.clock();
  const id = `_${input.uuid()}`;
  const unsigned = entry.version === '2.0' ? saml2(entry, id, now, input) : saml1(entry, id, now, input);
  const signing = input.signing;
  if (signing === undefined || entry.sign === undefined) return unsigned;
  const algorithm = entry.sign.signatureAlgorithm;
  const idAttribute = entry.version === '2.0' ? 'ID' : 'AssertionID';
  const signer = new SignedXml({
    privateKey: privateKeyOf(signing.alias, signing.passphrase),
    publicCert: signing.alias.certPem,
    canonicalizationAlgorithm: EXC_C14N,
    signatureAlgorithm: SIGNATURE_URIS[algorithm],
    getKeyInfoContent: () =>
      `<ds:X509Data><ds:X509Certificate>${certificateBase64(signing.alias.certPem)}</ds:X509Certificate></ds:X509Data>`,
  });
  signer.addReference({
    xpath: `/*[@${idAttribute}='${id}']`,
    transforms: [ENVELOPED, EXC_C14N],
    digestAlgorithm: DIGEST_URIS[algorithm],
  });
  // SAML 2.0's schema puts ds:Signature right after Issuer; SAML 1.1 puts it last.
  const location =
    entry.version === '2.0'
      ? { reference: `/*/*[local-name()='Issuer']`, action: 'after' as const }
      : { reference: '/*', action: 'append' as const };
  signer.computeSignature(unsigned, { prefix: 'ds', location });
  return signer.getSignedXml();
}
