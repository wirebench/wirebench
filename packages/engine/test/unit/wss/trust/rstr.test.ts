import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SignedXml } from 'xml-crypto';
import { describe, expect, it } from 'vitest';
import { parseRstr } from '../../../../src/wss/trust/rstr.js';
import { readAssertion } from '../../../../src/wss/saml/read.js';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/ws-trust/${name}`, import.meta.url)), 'utf8');

function failure(run: () => unknown): { code?: string; details?: Record<string, unknown> } {
  try {
    run();
  } catch (error) {
    return error as { code?: string; details?: Record<string, unknown> };
  }
  throw new Error('expected parseRstr to throw');
}

describe('parseRstr', () => {
  it('reads a WS-Trust 1.3 collection: token, attached reference, lifetime', () => {
    const parsed = parseRstr(fixture('rstrc-1.3-saml2.xml'), 200);
    expect(parsed.samlVersion).toBe('2.0');
    expect(parsed.assertionId).toBe('_fixture-2.0');
    expect(parsed.attachedReferenceXml).toContain('SecurityTokenReference');
    expect(parsed.expiresAt?.toISOString()).toBe('2026-10-05T11:00:00.000Z');
    // self-contained: parses on its own and declares its namespace
    expect(readAssertion(parsed.assertionXml).id).toBe('_fixture-2.0');
  });

  it('declares the namespaces of the attached reference on its own', () => {
    const parsed = parseRstr(fixture('rstrc-1.3-saml2.xml'), 200);
    expect(parsed.attachedReferenceXml).toContain('xmlns:wsse=');
  });

  // The fixture's assertion was edited (its signature no longer verifies); only parsing is tested.
  it("falls back to the assertion's NotOnOrAfter in a 2005/02 single response", () => {
    expect(parseRstr(fixture('rstr-2005-saml11.xml'), 200).expiresAt?.toISOString()).toBe('2026-10-05T10:30:00.000Z');
  });

  it('leaves expiresAt unset when neither gives one', () => {
    expect(parseRstr(fixture('rstr-none.xml'), 200).expiresAt).toBeUndefined();
  });

  it('keeps an EncryptedAssertion opaque', () => {
    const parsed = parseRstr(fixture('rstr-encrypted.xml'), 200);
    expect(parsed.assertionXml).toContain('EncryptedAssertion');
    expect(parsed.assertionId).toBeUndefined();
  });

  it('refuses a symmetric proof token', () => {
    expect(failure(() => parseRstr(fixture('rstr-proof-token.xml'), 200)).code).toBe(
      'ws-trust-symmetric-key-unsupported',
    );
  });

  it('turns a SOAP fault into ws-trust-sts-fault with code, reason and status', () => {
    const error = failure(() => parseRstr(fixture('fault-1.2.xml'), 500));
    expect(error.code).toBe('ws-trust-sts-fault');
    expect(error.details).toMatchObject({ status: 500, subcodes: ['a:FailedAuthentication'] });
    expect(error.details?.['faultCode']).toContain('Sender');
    expect(error.details?.['reason']).toContain('ID3242');
  });

  it('refuses a body with no token with ws-trust-response-invalid', () => {
    const empty = '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body/></s:Envelope>';
    expect(failure(() => parseRstr(empty, 200)).code).toBe('ws-trust-response-invalid');
  });

  it('refuses a 2xx body that is not XML with ws-trust-response-invalid', () => {
    expect(failure(() => parseRstr('<<not xml', 200)).code).toBe('ws-trust-response-invalid');
  });

  it('refuses a token that is not a SAML assertion, keeping the cause', () => {
    const xml = fixture('rstrc-1.3-saml2.xml').replace(
      /(<wst:RequestedSecurityToken>)[\s\S]*?(<\/wst:RequestedSecurityToken>)/,
      '$1<foo:X xmlns:foo="urn:foo"/>$2',
    );
    const error = failure(() => parseRstr(xml, 200)) as { code?: string; cause?: unknown };
    expect(error.code).toBe('ws-trust-response-invalid');
    expect(error.cause).toBeDefined();
  });

  it('keeps a prefix used only in an attribute value, declared on the envelope', () => {
    const xml = fixture('rstrc-1.3-saml2.xml')
      .replace(
        '<s:Envelope ',
        '<s:Envelope xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ',
      )
      .replace('<saml2:NameID>', '<saml2:NameID xsi:type="xs:string">');
    const parsed = parseRstr(xml, 200);
    expect(parsed.assertionXml).toContain('xmlns:xs="http://www.w3.org/2001/XMLSchema"');
    expect(parsed.assertionXml).toContain('xmlns:xsi=');
  });

  it('keeps the issuer signature valid when the envelope declares extra prefixes', () => {
    const xml = fixture('rstrc-1.3-saml2.xml').replace(
      '<s:Envelope ',
      '<s:Envelope xmlns:extra="urn:extra" xmlns="urn:default" ',
    );
    const parsed = parseRstr(xml, 200);
    const verifier = new SignedXml({
      publicCert: readFileSync(
        fileURLToPath(new URL('../../../fixtures/saml/issuer-cert.pem', import.meta.url)),
        'utf8',
      ),
      getCertFromKeyInfo: () => null,
    });
    verifier.loadSignature(/<ds:Signature[\s\S]*<\/ds:Signature>/.exec(parsed.assertionXml)?.[0] ?? '');
    expect(verifier.checkSignature(parsed.assertionXml)).toBe(true);
  });

  it('treats a non-2xx body that is not XML as a fault carrying the status', () => {
    const error = failure(() => parseRstr('<<not xml', 502));
    expect(error.code).toBe('ws-trust-sts-fault');
    expect(error.details).toMatchObject({ status: 502 });
  });
});
