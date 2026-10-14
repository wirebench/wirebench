import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import { describe, expect, it } from 'vitest';
import {
  IDP_CERT,
  OTHER_CERT,
  OTHER_KEY,
  alterAttribute,
  readAuthorizationUrl,
  signedResponse,
  stripSignature,
} from '../../helpers/saml-idp.js';

const INPUT = {
  inResponseTo: '_req1',
  audience: 'https://wirebench.test/api/v1/auth/saml/metadata',
  recipient: 'https://wirebench.test/api/v1/auth/saml/acs',
  now: new Date('2026-10-13T12:00:00Z'),
};

/** Verifies the assertion's signature against `cert`, the way a relying party would. */
function verifies(xml: string, cert: string): boolean {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const signature = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')[0];
  if (signature === undefined) return false;
  const sig = new SignedXml({ publicCert: cert });
  sig.loadSignature(new XMLSerializer().serializeToString(signature));
  try {
    return sig.checkSignature(xml);
  } catch {
    return false;
  }
}

describe('the test identity provider (saml-scim plan ruling 9)', () => {
  it('signs an assertion that verifies against its certificate and not another', () => {
    const xml = signedResponse(INPUT);
    expect(verifies(xml, IDP_CERT)).toBe(true);
    expect(verifies(xml, OTHER_CERT)).toBe(false);
  });

  it('signs with another key when asked, which its own certificate does not verify', () => {
    const xml = signedResponse(INPUT, { key: OTHER_KEY });
    expect(verifies(xml, OTHER_CERT)).toBe(true);
    expect(verifies(xml, IDP_CERT)).toBe(false);
  });

  it('an altered attribute breaks the signature, and a stripped one leaves none', () => {
    const xml = signedResponse(INPUT);
    expect(verifies(alterAttribute(xml, 'ada@example.com', 'eve@example.com'), IDP_CERT)).toBe(false);
    expect(verifies(stripSignature(xml), IDP_CERT)).toBe(false);
  });

  it('reads an AuthnRequest and RelayState back out of a redirect URL', async () => {
    const { deflateRawSync } = await import('node:zlib');
    const request = '<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_abc" Version="2.0"/>';
    const url = new URL('https://idp.example.test/saml/sso');
    url.searchParams.set('SAMLRequest', deflateRawSync(Buffer.from(request)).toString('base64'));
    url.searchParams.set('RelayState', 'relay');
    expect(readAuthorizationUrl(url.href)).toEqual({ xml: request, relayState: 'relay', id: '_abc' });
  });
});
