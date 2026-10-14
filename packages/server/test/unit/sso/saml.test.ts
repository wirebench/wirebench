import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseIdpMetadata } from '../../../src/sso/saml-metadata.js';
import { SamlRejected, claimsOf, samlProvider, type SamlAssertion } from '../../../src/sso/saml.js';
import {
  EMAIL_CLAIM,
  EMAIL_FORMAT,
  IDP_ENTITY_ID,
  IDP_KEY,
  IDP_SSO_URL,
  OTHER_KEY,
  TRANSIENT,
  alterAttribute,
  buildAssertion,
  encode,
  idpMetadata,
  readAuthorizationUrl,
  signElement,
  signedResponse,
  stripSignature,
  wrapInExtensions,
  wrapInObject,
  wrapResponse,
  wrapSibling,
  type ResponseInput,
} from '../../helpers/saml-idp.js';

const ENTITY_ID = 'https://wirebench.test/api/v1/auth/saml/metadata';
const ACS = 'https://wirebench.test/api/v1/auth/saml/acs';
const NOW = new Date('2026-10-13T12:00:00.000Z');
const REQUEST = '_0123456789abcdef0123456789abcdef01234567';

const provider = (clockSkewMs = 120_000) =>
  samlProvider(parseIdpMetadata(idpMetadata()), { entityId: ENTITY_ID, acsUrl: ACS, clockSkewMs });

const input = (overrides: Partial<ResponseInput> = {}): ResponseInput => ({
  inResponseTo: REQUEST,
  audience: ENTITY_ID,
  recipient: ACS,
  now: NOW,
  ...overrides,
});

const validate = (xml: string, requestId = REQUEST, p = provider()) =>
  p.validate({ samlResponse: encode(xml), requestId });

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SamlRejected) return error.reason;
    throw error;
  }
  return 'accepted';
}

describe('SamlProvider (saml-scim spec §3.2, §6.1)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds an AuthnRequest with our request ID, issuer, ACS and persistent NameID policy', async () => {
    const url = await provider().authorizationUrl({ requestId: REQUEST, relayState: 'relay-secret' });
    expect(url.startsWith(`${IDP_SSO_URL}?`)).toBe(true);
    const request = readAuthorizationUrl(url);
    expect(request.id).toBe(REQUEST);
    expect(request.relayState).toBe('relay-secret');
    expect(request.xml).toContain(`AssertionConsumerServiceURL="${ACS}"`);
    expect(request.xml).toContain(`>${ENTITY_ID}</saml:Issuer>`);
    expect(request.xml).toContain('urn:oasis:names:tc:SAML:2.0:nameid-format:persistent');
  });

  it('accepts a response whose assertion the IdP signed, and reports what it asserts', async () => {
    const assertion = await validate(
      signedResponse(input({ attributes: { [EMAIL_CLAIM]: 'ada@example.com', displayName: 'Ada' } })),
    );
    expect(assertion).toEqual({
      issuer: IDP_ENTITY_ID,
      nameId: 'ada-persistent-id',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
      attributes: { [EMAIL_CLAIM]: ['ada@example.com'], displayName: ['Ada'] },
    });
  });

  it('accepts a response the IdP signed whole as well as its assertion', async () => {
    const signedAssertion = signElement(buildAssertion(input()), 'Assertion', IDP_KEY);
    const both = signElement(wrapResponse(signedAssertion, input()), 'Response', IDP_KEY);
    expect(await refusal(validate(both))).toBe('accepted');
  });

  it.each([
    [
      'an attribute altered after signing',
      () => alterAttribute(signedResponse(input()), 'ada@example.com', 'eve@example.com'),
      'saml-signature',
    ],
    ['an unsigned assertion', () => stripSignature(signedResponse(input())), 'saml-signature'],
    [
      'an unsigned assertion inside a response signed whole',
      () => signElement(wrapResponse(buildAssertion(input()), input()), 'Response', IDP_KEY),
      'saml-signature',
    ],
    ['an assertion signed by another key', () => signedResponse(input(), { key: OTHER_KEY }), 'saml-signature'],
    ['a sibling evil assertion (XSW)', () => wrapSibling(input(), 'eve', 'eve@example.com'), 'saml-signature'],
    [
      'the signed assertion moved into Extensions (XSW)',
      () => wrapInExtensions(input(), 'eve', 'eve@example.com'),
      'saml-signature',
    ],
    [
      'the signed assertion hidden in ds:Object (XSW)',
      () => wrapInObject(input(), 'eve', 'eve@example.com'),
      'saml-signature',
    ],
    ['another issuer', () => signedResponse(input({ issuer: 'https://evil.example.test' })), 'saml-issuer'],
    ['another audience', () => signedResponse(input({ audience: 'https://other-sp.example.test' })), 'saml-audience'],
    [
      'another Recipient',
      () => signedResponse(input({ recipient: 'https://other-sp.example.test/acs', destination: ACS })),
      'saml-recipient',
    ],
    [
      'another Destination',
      () => signedResponse(input({ destination: 'https://other-sp.example.test/acs' })),
      'saml-recipient',
    ],
    ['no InResponseTo (IdP-initiated)', () => signedResponse(input({ inResponseTo: null })), 'saml-in-response-to'],
    [
      'another flow’s InResponseTo',
      () => signedResponse(input({ inResponseTo: '_someone-elses-request' })),
      'saml-in-response-to',
    ],
    ['a SHA-1 signature', () => signedResponse(input(), { algorithm: 'sha1' }), 'saml-algorithm'],
    [
      'a Responder status',
      () => wrapResponse('', input({ status: 'urn:oasis:names:tc:SAML:2.0:status:Responder' })),
      'saml-status',
    ],
    ['garbage', () => 'not xml at all <', 'saml-malformed'],
  ])('refuses %s', async (_name, build, reason) => {
    expect(await refusal(validate(build()))).toBe(reason);
  });

  it('never returns the evil identity from any wrapping variant', async () => {
    for (const xml of [
      wrapSibling(input(), 'eve', 'eve@example.com'),
      wrapInExtensions(input(), 'eve', 'eve@example.com'),
      wrapInObject(input(), 'eve', 'eve@example.com'),
    ]) {
      const result = await validate(xml).catch(() => undefined);
      expect(result?.nameId).not.toBe('eve');
    }
  });

  it('honours the validity window with the configured skew', async () => {
    const expired = signedResponse(input({ now: new Date(NOW.getTime() - 10 * 60_000), validFor: 300 }));
    expect(await refusal(validate(expired))).toBe('saml-expired');
    const future = signedResponse(input({ now: new Date(NOW.getTime() + 10 * 60_000) }));
    expect(await refusal(validate(future))).toBe('saml-expired');
    // Ends 60 s ago: inside a 120 s skew, outside a 30 s one.
    const justEnded = signedResponse(input({ now: new Date(NOW.getTime() - 360_000), validFor: 300 }));
    expect(await refusal(validate(justEnded))).toBe('accepted');
    expect(await refusal(validate(justEnded, REQUEST, provider(30_000)))).toBe('saml-expired');
  });

  it('serves SP metadata naming our entity ID and ACS', () => {
    const xml = provider().metadata();
    expect(xml).toContain(`entityID="${ENTITY_ID}"`);
    expect(xml).toContain(`Location="${ACS}"`);
  });
});

describe('claimsOf (saml-scim spec §3.3)', () => {
  const assertion = (overrides: Partial<SamlAssertion> = {}): SamlAssertion => ({
    issuer: IDP_ENTITY_ID,
    nameId: 'n-1',
    nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
    attributes: {},
    ...overrides,
  });

  it('takes the usual email and name claims in order', () => {
    expect(
      claimsOf(
        assertion({
          attributes: {
            mail: ['second@example.com'],
            [EMAIL_CLAIM]: ['first@example.com'],
            'http://schemas.microsoft.com/identity/claims/displayname': ['Ada Lovelace'],
          },
        }),
        {},
      ),
    ).toEqual({
      ok: true,
      claims: { issuer: IDP_ENTITY_ID, subject: 'n-1', email: 'first@example.com', name: 'Ada Lovelace' },
    });
  });

  it('uses only the configured attributes when they are set', () => {
    const result = claimsOf(
      assertion({ attributes: { [EMAIL_CLAIM]: ['a@example.com'], upn: ['u@example.com'], cn: ['U'] } }),
      { emailAttribute: 'upn', nameAttribute: 'cn' },
    );
    expect(result).toMatchObject({ ok: true, claims: { email: 'u@example.com', name: 'U' } });
  });

  it('falls back to an email-format NameID, and to nothing for other formats', () => {
    expect(claimsOf(assertion({ nameId: 'ada@example.com', nameIdFormat: EMAIL_FORMAT }), {})).toMatchObject({
      claims: { email: 'ada@example.com' },
    });
    expect(claimsOf(assertion({ nameId: 'ada@example.com' }), {})).toEqual({
      ok: true,
      claims: { issuer: IDP_ENTITY_ID, subject: 'ada@example.com' },
    });
  });

  it('refuses a transient NameID', () => {
    expect(claimsOf(assertion({ nameIdFormat: TRANSIENT }), {})).toEqual({
      ok: false,
      code: 'identity-saml-transient-nameid',
    });
  });
});
