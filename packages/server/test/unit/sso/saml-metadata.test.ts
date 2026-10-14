import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { MetadataError, loadIdpMetadata, parseIdpMetadata } from '../../../src/sso/saml-metadata.js';
import { IDP_CERT, IDP_ENTITY_ID, IDP_SSO_URL, OTHER_CERT, idpMetadata, pemBody } from '../../helpers/saml-idp.js';

const FIXTURES = new URL('../../fixtures/saml/', import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');
const bodies = (pems: readonly string[]) => pems.map(pemBody);

describe('IdP metadata (saml-scim spec §3.1)', () => {
  it('reads an Entra ID-shaped document, ignoring the WS-Federation role’s key', () => {
    const metadata = parseIdpMetadata(fixture('entra-metadata.xml'));
    expect(metadata.entityId).toBe('https://sts.windows.net/00000000-0000-0000-0000-000000000000/');
    expect(metadata.ssoUrl).toBe('https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/saml2');
    expect(bodies(metadata.certificates)).toEqual([pemBody(IDP_CERT)]);
  });

  it('reads an Okta-shaped document, taking the redirect binding over POST', () => {
    const metadata = parseIdpMetadata(fixture('okta-metadata.xml'));
    expect(metadata.entityId).toBe('http://www.okta.com/exk000000000000000');
    expect(metadata.ssoUrl).toBe('https://example.okta.com/app/example_wirebench_1/exk000000000000000/sso/saml');
    expect(bodies(metadata.certificates)).toEqual([pemBody(IDP_CERT)]);
  });

  it('keeps every signing certificate, so a rotation can be published before it happens', () => {
    const metadata = parseIdpMetadata(idpMetadata({ certs: [IDP_CERT, OTHER_CERT] }));
    expect(metadata).toMatchObject({ entityId: IDP_ENTITY_ID, ssoUrl: IDP_SSO_URL });
    expect(bodies(metadata.certificates)).toEqual([pemBody(IDP_CERT), pemBody(OTHER_CERT)]);
  });

  it('ignores an encryption-only key', () => {
    const xml = idpMetadata({ certs: [IDP_CERT, OTHER_CERT] }).replace('use="signing"', 'use="encryption"');
    expect(bodies(parseIdpMetadata(xml).certificates)).toEqual([pemBody(OTHER_CERT)]);
  });

  it.each([
    [
      'no redirect binding',
      idpMetadata().replace(/<md:SingleSignOnService Binding="[^"]*HTTP-Redirect"[^>]*\/>/, ''),
      /HTTP-Redirect/,
    ],
    ['no signing key', idpMetadata({ certs: [] }), /no signing certificate/],
    [
      'no IDPSSODescriptor',
      '<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x"/>',
      /IDPSSODescriptor/,
    ],
    ['no entityID', idpMetadata().replace(/ entityID="[^"]*"/, ''), /entityID/],
    [
      'a certificate that does not parse',
      idpMetadata().replace(/<ds:X509Certificate>[^<]+/, '<ds:X509Certificate>bm90IGEgY2VydA=='),
      /does not parse/,
    ],
    ['garbage', 'this is not xml <', /well-formed|IDPSSODescriptor/],
    [
      'a DOCTYPE',
      `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]>${idpMetadata().replace('<?xml version="1.0"?>', '')}`,
      /DOCTYPE/,
    ],
  ])('refuses metadata with %s', (_name, xml, message) => {
    expect(() => parseIdpMetadata(xml)).toThrow(MetadataError);
    expect(() => parseIdpMetadata(xml)).toThrow(message);
  });

  it('loads from an absolute file path', async () => {
    const path = fileURLToPath(new URL('okta-metadata.xml', FIXTURES));
    expect((await loadIdpMetadata(path, { allowInsecure: false })).entityId).toBe(
      'http://www.okta.com/exk000000000000000',
    );
  });

  it('fetches an https:// URL, refuses http:// unless insecure is allowed, and reports a failed fetch', async () => {
    const ok = vi.fn(() => Promise.resolve(new Response(idpMetadata(), { status: 200 })));
    const options = { allowInsecure: false, fetch: ok as unknown as typeof fetch };
    expect((await loadIdpMetadata('https://idp.example.test/metadata', options)).entityId).toBe(IDP_ENTITY_ID);
    await expect(loadIdpMetadata('http://idp.example.test/metadata', options)).rejects.toThrow(/https/);
    await expect(
      loadIdpMetadata('http://idp.example.test/metadata', { ...options, allowInsecure: true }),
    ).resolves.toBeDefined();
    const missing = vi.fn(() => Promise.resolve(new Response('nope', { status: 404 })));
    await expect(
      loadIdpMetadata('https://idp.example.test/metadata', { allowInsecure: false, fetch: missing }),
    ).rejects.toThrow(/404/);
  });
});
