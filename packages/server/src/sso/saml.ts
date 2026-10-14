/**
 * SAML sign-in through `@node-saml/node-saml` (saml-scim spec §6.1). Nothing outside this file names the
 * library, and nothing in Wirebench reads a `SAMLResponse` itself: every value comes from what the library
 * validated. On top of the library's checks this file adds the three it does not make on a POST response
 * (the assertion's `Issuer`, the `Recipient` of the validated assertion and the response's `Destination`)
 * and an algorithm allow-list. node-saml 5.1 applies `idpIssuer` to logout messages only.
 *
 * A `SAML` instance is built per call (plan ruling 2). The one that starts a flow uses the flow's own
 * request ID; the one that validates answers `InResponseTo` for that ID only, so a response can only
 * complete the flow whose `RelayState` it came back with.
 */
import { SAML, SamlStatusError, ValidateInResponseTo, type CacheProvider, type Profile } from '@node-saml/node-saml';
import { DOMParser, type Element } from '@xmldom/xmldom';
import type { IdpMetadata } from './saml-metadata.js';

export const PERSISTENT_NAME_ID = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
const TRANSIENT_NAME_ID = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';
const EMAIL_NAME_ID = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
const SAML_ASSERTION = 'urn:oasis:names:tc:SAML:2.0:assertion';
const SAML_PROTOCOL = 'urn:oasis:names:tc:SAML:2.0:protocol';
const DS = 'http://www.w3.org/2000/09/xmldsig#';

/** §6.1: SHA-1 is refused wherever it appears. */
const ALLOWED_SIGNATURE_METHODS = new Set([
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha384',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512',
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256',
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha384',
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha512',
]);
const ALLOWED_DIGEST_METHODS = new Set([
  'http://www.w3.org/2001/04/xmlenc#sha256',
  'http://www.w3.org/2001/04/xmldsig-more#sha384',
  'http://www.w3.org/2001/04/xmlenc#sha512',
]);

const EMAIL_ATTRIBUTES = [
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'email',
  'mail',
  'urn:oid:0.9.2342.19200300.100.1.3',
];
const NAME_ATTRIBUTES = [
  'http://schemas.microsoft.com/identity/claims/displayname',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  'displayName',
];

/** Every way a response is refused, as `auth.sign_in_failed` records it (§6.1). */
export type SamlRefusal =
  | 'saml-signature'
  | 'saml-issuer'
  | 'saml-audience'
  | 'saml-recipient'
  | 'saml-expired'
  | 'saml-in-response-to'
  | 'saml-algorithm'
  | 'saml-malformed'
  | 'saml-status';

export class SamlRejected extends Error {
  override readonly name = 'SamlRejected';
  constructor(
    readonly reason: SamlRefusal,
    message: string,
  ) {
    super(message);
  }
}

/** What a validated assertion says, before the claims mapping. */
export interface SamlAssertion {
  readonly issuer: string;
  readonly nameId: string;
  readonly nameIdFormat: string | undefined;
  readonly attributes: Readonly<Record<string, readonly string[]>>;
}

export interface SamlProviderSettings {
  /** Our entity ID, which is also the audience an assertion must name. */
  readonly entityId: string;
  readonly acsUrl: string;
  readonly clockSkewMs: number;
}

export interface SamlProvider {
  readonly idpEntityId: string;
  readonly entityId: string;
  readonly acsUrl: string;
  /** The IdP's SSO URL carrying a deflated `AuthnRequest` with `ID = requestId`, and the `RelayState`. */
  authorizationUrl(input: { readonly requestId: string; readonly relayState: string }): Promise<string>;
  /** The validated assertion, or a `SamlRejected`. `requestId` is the flow's own. */
  validate(input: { readonly samlResponse: string; readonly requestId: string }): Promise<SamlAssertion>;
  /** This server's SP metadata, for the IdP to import. */
  metadata(): string;
}

/** Answers `InResponseTo` for one request ID only; a validation never needs another. */
function oneRequestCache(requestId: string): CacheProvider {
  return {
    saveAsync: () => Promise.resolve(null),
    // The flow's own life (ten minutes, checked by the route) is what expires a request, so "now" is
    // always a valid creation time here.
    getAsync: (key) => Promise.resolve(key === requestId ? new Date().toISOString() : null),
    removeAsync: () => Promise.resolve(null),
  };
}

const elements = (parent: Element, ns: string, local: string): Element[] =>
  Array.from(parent.getElementsByTagNameNS(ns, local));

function parse(xml: string): Element {
  const fail = (message: string): never => {
    throw new SamlRejected('saml-malformed', message);
  };
  const root = new DOMParser({
    errorHandler: (level: string, message: unknown) => {
      if (level !== 'warning') fail(String(message));
    },
  }).parseFromString(xml, 'text/xml').documentElement;
  return root ?? fail('the response is not well-formed XML');
}

function reasonOf(error: unknown): SamlRefusal {
  if (error instanceof SamlStatusError) return 'saml-status';
  const message = error instanceof Error ? error.message : '';
  if (/InResponseTo/i.test(message)) return 'saml-in-response-to';
  if (/signature|signed data/i.test(message)) return 'saml-signature';
  if (/issuer/i.test(message)) return 'saml-issuer';
  if (/audience|AudienceRestriction/i.test(message)) return 'saml-audience';
  if (/expired|not yet valid|subject confirmation/i.test(message)) return 'saml-expired';
  return 'saml-malformed';
}

/**
 * The checks node-saml leaves to us. Algorithms are judged on the whole document, signed or not: refusing
 * a SHA-1 anywhere can only refuse more. `Recipient` is read from the validated assertion; `Destination`
 * from the response, which is harmless to read unsigned because it can only cause a refusal.
 */
function checkExtras(rawXml: string, assertionXml: string, acsUrl: string): void {
  const raw = parse(rawXml);
  for (const method of elements(raw, DS, 'SignatureMethod'))
    if (!ALLOWED_SIGNATURE_METHODS.has(method.getAttribute('Algorithm') ?? ''))
      throw new SamlRejected(
        'saml-algorithm',
        `signature algorithm ${method.getAttribute('Algorithm') ?? ''} is refused`,
      );
  for (const method of elements(raw, DS, 'DigestMethod'))
    if (!ALLOWED_DIGEST_METHODS.has(method.getAttribute('Algorithm') ?? ''))
      throw new SamlRejected('saml-algorithm', `digest algorithm ${method.getAttribute('Algorithm') ?? ''} is refused`);
  if (raw.localName === 'Response' && raw.namespaceURI === SAML_PROTOCOL) {
    const destination = raw.getAttribute('Destination');
    if (destination !== null && destination !== '' && destination !== acsUrl)
      throw new SamlRejected('saml-recipient', 'the response names another Destination');
  }
  const assertion = parse(assertionXml);
  const recipients = elements(assertion, SAML_ASSERTION, 'SubjectConfirmationData').map((data) =>
    data.getAttribute('Recipient'),
  );
  if (recipients.length === 0 || recipients.some((recipient) => recipient !== acsUrl))
    throw new SamlRejected('saml-recipient', 'the assertion names another Recipient');
}

function attributesOf(profile: Profile): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const attributes = (profile.attributes ?? {}) as Record<string, unknown>;
  for (const [name, value] of Object.entries(attributes)) {
    const values = (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string');
    if (values.length > 0) out[name] = values;
  }
  return out;
}

export function samlProvider(metadata: IdpMetadata, settings: SamlProviderSettings): SamlProvider {
  const base = {
    idpCert: [...metadata.certificates],
    idpIssuer: metadata.entityId,
    entryPoint: metadata.ssoUrl,
    issuer: settings.entityId,
    audience: settings.entityId,
    callbackUrl: settings.acsUrl,
    identifierFormat: PERSISTENT_NAME_ID,
    wantAssertionsSigned: true,
    // Entra ID signs only the assertion by default; the assertion's signature is the one that matters.
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: settings.clockSkewMs,
    validateInResponseTo: ValidateInResponseTo.always,
    disableRequestedAuthnContext: true,
    signatureAlgorithm: 'sha256' as const,
    digestAlgorithm: 'sha256' as const,
  };
  return {
    idpEntityId: metadata.entityId,
    entityId: settings.entityId,
    acsUrl: settings.acsUrl,

    authorizationUrl: ({ requestId, relayState }) =>
      new SAML({ ...base, generateUniqueId: () => requestId }).getAuthorizeUrlAsync(relayState, undefined, {}),

    validate: async ({ samlResponse, requestId }) => {
      const saml = new SAML({ ...base, cacheProvider: oneRequestCache(requestId) });
      let profile: Profile | null;
      try {
        ({ profile } = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse }));
      } catch (error) {
        if (error instanceof SamlRejected) throw error;
        throw new SamlRejected(reasonOf(error), error instanceof Error ? error.message : String(error));
      }
      if (profile === null || profile.getAssertionXml === undefined)
        throw new SamlRejected('saml-malformed', 'the response carried no assertion');
      checkExtras(Buffer.from(samlResponse, 'base64').toString('utf8'), profile.getAssertionXml(), settings.acsUrl);
      // A key the IdP holds may sign for another entity; only ours is accepted.
      if (profile.issuer !== metadata.entityId)
        throw new SamlRejected('saml-issuer', 'the assertion names another issuer');
      if (!profile.nameID) throw new SamlRejected('saml-malformed', 'the assertion has no NameID');
      return {
        issuer: profile.issuer,
        nameId: profile.nameID,
        nameIdFormat: profile.nameIDFormat || undefined,
        attributes: attributesOf(profile),
      };
    },

    metadata: () => new SAML({ ...base }).generateServiceProviderMetadata(null, null),
  };
}

// ---- claims (spec §3.3) ---------------------------------------------------------------------

export interface SamlClaimSettings {
  readonly emailAttribute?: string;
  readonly nameAttribute?: string;
}

export interface SamlClaims {
  readonly issuer: string;
  readonly subject: string;
  readonly email?: string;
  readonly name?: string;
}

export type ClaimsOutcome =
  | { readonly ok: true; readonly claims: SamlClaims }
  | { readonly ok: false; readonly code: 'identity-saml-transient-nameid' };

const firstOf = (attributes: SamlAssertion['attributes'], names: readonly string[]): string | undefined => {
  for (const name of names) {
    const value = attributes[name]?.find((v) => v.trim() !== '');
    if (value !== undefined) return value.trim();
  }
  return undefined;
};

/** The identity a validated assertion asserts: the configured attribute first, then the usual names. */
export function claimsOf(assertion: SamlAssertion, settings: SamlClaimSettings): ClaimsOutcome {
  if (assertion.nameIdFormat === TRANSIENT_NAME_ID) return { ok: false, code: 'identity-saml-transient-nameid' };
  const email =
    firstOf(
      assertion.attributes,
      settings.emailAttribute !== undefined ? [settings.emailAttribute] : EMAIL_ATTRIBUTES,
    ) ??
    (settings.emailAttribute === undefined && assertion.nameIdFormat === EMAIL_NAME_ID ? assertion.nameId : undefined);
  const name = firstOf(
    assertion.attributes,
    settings.nameAttribute !== undefined ? [settings.nameAttribute] : NAME_ATTRIBUTES,
  );
  return {
    ok: true,
    claims: {
      issuer: assertion.issuer,
      subject: assertion.nameId,
      ...(email !== undefined ? { email } : {}),
      ...(name !== undefined ? { name } : {}),
    },
  };
}
