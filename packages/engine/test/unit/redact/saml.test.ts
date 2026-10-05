import { describe, expect, it } from 'vitest';
import { redactXml, REDACTED_XML_MARKER } from '../../../src/redact/index.js';

const SIGNED =
  '<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1">' +
  '<saml2:Issuer>urn:sts</saml2:Issuer>' +
  '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo/>' +
  '<ds:SignatureValue>c2lnbmF0dXJl</ds:SignatureValue></ds:Signature>' +
  '<saml2:Subject><saml2:NameID>alice</saml2:NameID></saml2:Subject></saml2:Assertion>';

describe('redactXml on security tokens', () => {
  it("masks an assertion's signature value and keeps the rest readable", () => {
    const out = redactXml(SIGNED);
    expect(out).not.toContain('c2lnbmF0dXJl');
    expect(out).toContain(`<ds:SignatureValue>${REDACTED_XML_MARKER}</ds:SignatureValue>`);
    expect(out).toContain('<saml2:NameID>alice</saml2:NameID>');
    expect(out).toContain('urn:sts');
  });

  it('leaves a message signature outside any assertion alone', () => {
    const message = '<ds:Signature xmlns:ds="x"><ds:SignatureValue>bWVzc2FnZQ==</ds:SignatureValue></ds:Signature>';
    expect(redactXml(message)).toContain('bWVzc2FnZQ==');
  });

  it('masks cipher values inside an EncryptedAssertion', () => {
    const encrypted =
      '<saml2:EncryptedAssertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion">' +
      '<xenc:EncryptedData xmlns:xenc="http://www.w3.org/2001/04/xmlenc#"><xenc:CipherData>' +
      '<xenc:CipherValue>Y2lwaGVy</xenc:CipherValue></xenc:CipherData></xenc:EncryptedData></saml2:EncryptedAssertion>';
    expect(redactXml(encrypted)).not.toContain('Y2lwaGVy');
  });

  it('masks a Kerberos BinarySecurityToken and keeps an X.509 one', () => {
    const kerberos =
      '<wsse:BinarySecurityToken ValueType="http://docs.oasis-open.org/wss/oasis-wss-kerberos-token-profile-1.1#GSS_Kerberosv5_AP_REQ">' +
      'YXByZXE=</wsse:BinarySecurityToken>';
    const x509 =
      '<wsse:BinarySecurityToken ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3">' +
      'Y2VydA==</wsse:BinarySecurityToken>';
    expect(redactXml(kerberos)).not.toContain('YXByZXE=');
    expect(redactXml(x509)).toContain('Y2VydA==');
  });

  it('masks nothing when show is set', () => {
    expect(redactXml(SIGNED, { show: true })).toBe(SIGNED);
  });

  it('stays linear on an unclosed assertion in a large response', () => {
    const text = '<saml2:Assertion>' + '<saml2:Assertion>'.repeat(2000) + 'x'.repeat(256 * 1024);
    const started = performance.now();
    redactXml(text);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
