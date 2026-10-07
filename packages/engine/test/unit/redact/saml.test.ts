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

  it("masks a proof token's binary secret and cipher value, keeping the markup", () => {
    const proof =
      '<wst:RequestedProofToken xmlns:wst="http://docs.oasis-open.org/ws-sx/ws-trust/200512">' +
      '<wst:BinarySecret>S0VZQllURVM=</wst:BinarySecret></wst:RequestedProofToken>';
    const out = redactXml(proof);
    expect(out).not.toContain('S0VZQllURVM=');
    expect(out).toContain(`<wst:BinarySecret>${REDACTED_XML_MARKER}</wst:BinarySecret></wst:RequestedProofToken>`);
    const wrapped =
      '<wst:RequestedProofToken xmlns:wst="x" xmlns:xenc="y"><xenc:CipherValue>cHJvb2Y=</xenc:CipherValue></wst:RequestedProofToken>';
    expect(redactXml(wrapped)).not.toContain('cHJvb2Y=');
  });

  it("masks an entropy's binary secret beside the proof token, keeping the markup", () => {
    const rstr =
      '<wst:RequestSecurityTokenResponse xmlns:wst="x"><wst:Entropy><wst:BinarySecret Type="n">ZW50cm9weQ==</wst:BinarySecret></wst:Entropy>' +
      '<wst:Lifetime>soon</wst:Lifetime></wst:RequestSecurityTokenResponse>';
    const out = redactXml(rstr);
    expect(out).not.toContain('ZW50cm9weQ==');
    expect(out).toContain(`<wst:BinarySecret Type="n">${REDACTED_XML_MARKER}</wst:BinarySecret></wst:Entropy>`);
    expect(out).toContain('<wst:Lifetime>soon</wst:Lifetime>');
  });

  it('masks nothing when show is set', () => {
    expect(redactXml(SIGNED, { show: true })).toBe(SIGNED);
  });

  it('masks a signed assertion that follows a self-closing one', () => {
    const out = redactXml(`<saml2:Assertion/>${SIGNED}`);
    expect(out).not.toContain('c2lnbmF0dXJl');
    expect(out.startsWith('<saml2:Assertion/>')).toBe(true);
    expect(out).toContain('<saml2:NameID>alice</saml2:NameID>');
  });

  it('masks an unprefixed assertion', () => {
    const unprefixed =
      '<Assertion xmlns="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a2"><Issuer>urn:sts</Issuer>' +
      '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo/><SignatureValue>dW5wcmVmaXhlZA==</SignatureValue>' +
      '</Signature></Assertion>';
    const out = redactXml(unprefixed);
    expect(out).not.toContain('dW5wcmVmaXhlZA==');
    expect(out).toContain(`<SignatureValue>${REDACTED_XML_MARKER}</SignatureValue>`);
  });

  it('leaves an unclosed assertion in a large response as it is', () => {
    // Its timing is gated in test/perf/redact-saml.perf.test.ts.
    const text = '<saml2:Assertion>' + '<saml2:Assertion>'.repeat(2000) + 'x'.repeat(256 * 1024);
    expect(redactXml(text)).toBe(text);
  });

  it('masks a complete assertion that follows a truncated one', () => {
    const out = redactXml(`<saml2:Assertion ID="_cut"><saml2:Issuer>urn:sts</saml2:Issuer>${SIGNED}`);
    expect(out).not.toContain('c2lnbmF0dXJl');
    expect(out).toContain(`<ds:SignatureValue>${REDACTED_XML_MARKER}</ds:SignatureValue>`);
    expect(out).toContain('<saml2:NameID>alice</saml2:NameID>');
  });

  it('masks a secret inside an unclosed container: too much rather than too little', () => {
    const cut =
      '<saml2:Assertion ID="_cut"><ds:Signature xmlns:ds="x"><ds:SignatureValue>dHJ1bmNhdGVk</ds:SignatureValue></ds:Signature>' +
      '<saml2:Subject><saml2:NameID>bob</saml2:NameID>';
    const out = redactXml(cut);
    expect(out).not.toContain('dHJ1bmNhdGVk');
    expect(out).toContain('<saml2:NameID>bob</saml2:NameID>');
  });
});
