/**
 * A test identity provider (saml-scim plan ruling 9): it builds SAML responses and signs them with
 * `xml-crypto` the way a real IdP does, so the server's validation runs against genuine signatures. The
 * tampering helpers each produce one of the attacks the spec's §6.1 table names. Test-only: the keys in
 * `fixtures/saml/` sign nothing outside this suite.
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { SignedXml } from 'xml-crypto';

const FIXTURES = new URL('../fixtures/saml/', import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');

export const IDP_KEY = fixture('idp-key.pem');
export const IDP_CERT = fixture('idp-cert.pem');
export const OTHER_KEY = fixture('other-key.pem');
export const OTHER_CERT = fixture('other-cert.pem');

export const IDP_ENTITY_ID = 'https://idp.example.test/saml';
export const IDP_SSO_URL = 'https://idp.example.test/saml/sso';
export const PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
export const TRANSIENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';
export const EMAIL_FORMAT = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
export const EMAIL_CLAIM = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress';

const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';
const RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
const SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1';
const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

/** The IdP's metadata, as an operator would download it. */
export function idpMetadata(options: { readonly certs?: readonly string[]; readonly entityId?: string } = {}): string {
  const keys = (options.certs ?? [IDP_CERT])
    .map(
      (cert) =>
        `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${pemBody(cert)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`,
    )
    .join('');
  return `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${options.entityId ?? IDP_ENTITY_ID}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    ${keys}
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${IDP_SSO_URL}/post"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${IDP_SSO_URL}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
}

export function pemBody(pem: string): string {
  return pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
}

/** The `AuthnRequest` inside an authorization URL, inflated, and the `RelayState` beside it. */
export function readAuthorizationUrl(url: string): {
  readonly xml: string;
  readonly relayState: string;
  readonly id: string;
} {
  const parsed = new URL(url);
  const xml = inflateRawSync(Buffer.from(parsed.searchParams.get('SAMLRequest') ?? '', 'base64')).toString('utf8');
  const id = /\sID="([^"]+)"/.exec(xml)?.[1] ?? '';
  return { xml, relayState: parsed.searchParams.get('RelayState') ?? '', id };
}

export interface ResponseInput {
  readonly inResponseTo?: string | null;
  readonly audience: string;
  readonly recipient: string;
  /** `null` leaves the attribute off the response, as some IdPs do. */
  readonly destination?: string | null;
  readonly now: Date;
  /** Seconds the assertion is valid for, from `now`. Default 300. */
  readonly validFor?: number;
  /** Seconds before `now` that `NotBefore` sits. Default 0. */
  readonly notBeforeOffset?: number;
  readonly nameId?: string;
  readonly nameIdFormat?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly issuer?: string;
  readonly status?: string;
  readonly assertionId?: string;
}

let counter = 0;
const nextId = (prefix: string): string => `_${prefix}${String(++counter).padStart(8, '0')}${Date.now().toString(16)}`;
const xmlEscape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildAssertion(input: ResponseInput): string {
  const issuer = input.issuer ?? IDP_ENTITY_ID;
  const instant = input.now.toISOString();
  const notBefore = new Date(input.now.getTime() - (input.notBeforeOffset ?? 0) * 1000).toISOString();
  const notOnOrAfter = new Date(input.now.getTime() + (input.validFor ?? 300) * 1000).toISOString();
  const inResponseTo =
    input.inResponseTo === null || input.inResponseTo === undefined ? '' : ` InResponseTo="${input.inResponseTo}"`;
  const attributes = Object.entries(input.attributes ?? { [EMAIL_CLAIM]: 'ada@example.com' })
    .map(
      ([name, value]) =>
        `<saml:Attribute Name="${xmlEscape(name)}"><saml:AttributeValue>${xmlEscape(value)}</saml:AttributeValue></saml:Attribute>`,
    )
    .join('');
  return (
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${input.assertionId ?? nextId('a')}" Version="2.0" IssueInstant="${instant}">` +
    `<saml:Issuer>${xmlEscape(issuer)}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="${input.nameIdFormat ?? PERSISTENT}">${xmlEscape(input.nameId ?? 'ada-persistent-id')}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData${inResponseTo} NotOnOrAfter="${notOnOrAfter}" Recipient="${xmlEscape(input.recipient)}"/>` +
    `</saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${xmlEscape(input.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${instant}" SessionIndex="${nextId('s')}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement>${attributes}</saml:AttributeStatement>` +
    `</saml:Assertion>`
  );
}

/** Wraps `assertion` (signed or not) in a `samlp:Response`. */
export function wrapResponse(assertion: string, input: ResponseInput): string {
  const inResponseTo =
    input.inResponseTo === null || input.inResponseTo === undefined ? '' : ` InResponseTo="${input.inResponseTo}"`;
  const destination =
    input.destination === null ? '' : ` Destination="${xmlEscape(input.destination ?? input.recipient)}"`;
  const status = input.status ?? 'urn:oasis:names:tc:SAML:2.0:status:Success';
  return (
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${nextId('r')}" Version="2.0" IssueInstant="${input.now.toISOString()}"${destination}${inResponseTo}>` +
    `<saml:Issuer>${xmlEscape(input.issuer ?? IDP_ENTITY_ID)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="${status}"/></samlp:Status>` +
    assertion +
    `</samlp:Response>`
  );
}

export type Algorithm = 'sha256' | 'sha1';

/** Signs the element with `localName` (the first one) in place, after its `Issuer`, as IdPs do. */
export function signElement(
  xml: string,
  localName: 'Assertion' | 'Response',
  key: string,
  algorithm: Algorithm = 'sha256',
): string {
  const sig = new SignedXml({
    privateKey: key,
    signatureAlgorithm: algorithm === 'sha256' ? RSA_SHA256 : RSA_SHA1,
    canonicalizationAlgorithm: EXC_C14N,
  });
  sig.addReference({
    xpath: `//*[local-name(.)='${localName}']`,
    transforms: [ENVELOPED, EXC_C14N],
    digestAlgorithm: algorithm === 'sha256' ? SHA256 : SHA1,
  });
  sig.computeSignature(xml, {
    prefix: 'ds',
    location: { reference: `//*[local-name(.)='${localName}']/*[local-name(.)='Issuer']`, action: 'after' },
  });
  return sig.getSignedXml();
}

/** A response whose assertion the IdP signed: the shape Entra ID sends by default. */
export function signedResponse(
  input: ResponseInput,
  options: { readonly key?: string; readonly algorithm?: Algorithm } = {},
): string {
  const assertion = signElement(buildAssertion(input), 'Assertion', options.key ?? IDP_KEY, options.algorithm);
  return wrapResponse(assertion, input);
}

/** What the browser posts to the ACS. */
export const encode = (xml: string): string => Buffer.from(xml, 'utf8').toString('base64');

// --- Tampering (spec §6.1) -------------------------------------------------------------------------

/** Changes an attribute value after signing: the digest no longer matches. */
export function alterAttribute(signed: string, from: string, to: string): string {
  if (!signed.includes(from)) throw new Error(`alterAttribute: ${from} is not in the response`);
  return signed.replace(from, to);
}

/** Removes the assertion's signature, leaving a well-formed unsigned assertion. */
export function stripSignature(signed: string): string {
  return signed.replace(/<ds:Signature[\s\S]*?<\/ds:Signature>/, '');
}

/** The signed `Assertion` element of a signed response. */
function signedAssertion(signedResponseXml: string): string {
  const match = /<saml:Assertion[\s\S]*<\/saml:Assertion>/.exec(signedResponseXml);
  if (match === null) throw new Error('no assertion');
  return match[0];
}

/** An unsigned assertion for `evilNameId` and `evilEmail`, sharing the input's conditions. */
function evilAssertion(input: ResponseInput, evilNameId: string, evilEmail: string, id?: string): string {
  return buildAssertion({
    ...input,
    nameId: evilNameId,
    attributes: { [EMAIL_CLAIM]: evilEmail },
    ...(id !== undefined ? { assertionId: id } : {}),
  });
}

/** XSW: an unsigned evil assertion placed before the genuine signed one, as a sibling. */
export function wrapSibling(input: ResponseInput, evilNameId: string, evilEmail: string): string {
  const genuine = signedResponse(input);
  const signed = signedAssertion(genuine);
  return genuine.replace(signed, evilAssertion(input, evilNameId, evilEmail) + signed);
}

/**
 * XSW: the evil assertion takes the genuine one's place and ID, and the signed original is moved into
 * `samlp:Extensions`, where its reference still resolves.
 */
export function wrapInExtensions(input: ResponseInput, evilNameId: string, evilEmail: string): string {
  const genuine = signedResponse(input);
  const signed = signedAssertion(genuine);
  const id = /ID="([^"]+)"/.exec(signed)?.[1];
  const evil = evilAssertion(input, evilNameId, evilEmail, id);
  // The genuine signature moves onto the evil assertion, pointing at the original inside Extensions.
  const signature = /<ds:Signature[\s\S]*?<\/ds:Signature>/.exec(signed)?.[0] ?? '';
  const evilSigned = evil.replace(/(<saml:Issuer>[^<]*<\/saml:Issuer>)/, `$1${signature}`);
  const original = signed.replace(signature, '');
  return genuine
    .replace(signed, evilSigned)
    .replace('<samlp:Status>', `<samlp:Extensions>${original}</samlp:Extensions><samlp:Status>`);
}

/** XSW: the genuine signed assertion is hidden inside the signature's `ds:Object`, the evil one in its place. */
export function wrapInObject(input: ResponseInput, evilNameId: string, evilEmail: string): string {
  const genuine = signedResponse(input);
  const signed = signedAssertion(genuine);
  const id = /ID="([^"]+)"/.exec(signed)?.[1];
  const signature = /<ds:Signature[\s\S]*?<\/ds:Signature>/.exec(signed)?.[0] ?? '';
  const original = signed.replace(signature, '');
  const objectSignature = signature.replace('</ds:Signature>', `<ds:Object>${original}</ds:Object></ds:Signature>`);
  const evil = evilAssertion(input, evilNameId, evilEmail, id).replace(
    /(<saml:Issuer>[^<]*<\/saml:Issuer>)/,
    `$1${objectSignature}`,
  );
  return genuine.replace(signed, evil);
}
