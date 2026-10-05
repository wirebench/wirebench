import { describe, expect, it } from 'vitest';
import { readAssertion } from '../../../../src/wss/saml/read.js';

const SAML2 =
  '<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1" Version="2.0"' +
  ' IssueInstant="2026-10-05T10:00:00Z"><saml2:Issuer>urn:test</saml2:Issuer></saml2:Assertion>';
const SAML1 =
  '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:1.0:assertion" AssertionID="_b1" MajorVersion="1"' +
  ' MinorVersion="1" Issuer="urn:test" IssueInstant="2026-10-05T10:00:00Z"/>';

describe('readAssertion', () => {
  it('reads a SAML 2.0 assertion and its ID', () => {
    expect(readAssertion(SAML2)).toMatchObject({ version: '2.0', id: '_a1', encrypted: false });
  });

  it('reads a SAML 1.1 assertion and its AssertionID', () => {
    expect(readAssertion(SAML1)).toMatchObject({ version: '1.1', id: '_b1', encrypted: false });
  });

  it('accepts an EncryptedAssertion as opaque, with no id', () => {
    const read = readAssertion(
      '<saml2:EncryptedAssertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion"><x/></saml2:EncryptedAssertion>',
    );
    expect(read).toMatchObject({ version: '2.0', encrypted: true });
    expect(read.id).toBeUndefined();
  });

  it('refuses any other root with saml-token-invalid', () => {
    expect(() => readAssertion('<Envelope/>')).toThrow(expect.objectContaining({ code: 'saml-token-invalid' }));
  });

  it('refuses text that is not XML with saml-token-invalid', () => {
    expect(() => readAssertion('not xml <')).toThrow(expect.objectContaining({ code: 'saml-token-invalid' }));
  });
});

describe('readAssertion confirmation selection', () => {
  const cert = (body: string) =>
    `<ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${body}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>`;
  const saml2 = (confirmations: string) =>
    '<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1" Version="2.0">' +
    `<saml2:Subject>${confirmations}</saml2:Subject></saml2:Assertion>`;
  const sc2 = (method: string, key: string) =>
    `<saml2:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:${method}"><saml2:SubjectConfirmationData>${key}</saml2:SubjectConfirmationData></saml2:SubjectConfirmation>`;
  const saml1 = (confirmations: string) =>
    '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:1.0:assertion" AssertionID="_b1" MajorVersion="1" MinorVersion="1">' +
    `<saml:AuthenticationStatement><saml:Subject>${confirmations}</saml:Subject></saml:AuthenticationStatement></saml:Assertion>`;
  const sc1 = (method: string, key: string) =>
    `<saml:SubjectConfirmation><saml:ConfirmationMethod>urn:oasis:names:tc:SAML:1.0:cm:${method}</saml:ConfirmationMethod>` +
    `<saml:SubjectConfirmationData>${key}</saml:SubjectConfirmationData></saml:SubjectConfirmation>`;

  it('picks the holder-of-key confirmation when a bearer one comes first (2.0)', () => {
    const read = readAssertion(saml2(sc2('bearer', cert('QkVBUkVS')) + sc2('holder-of-key', cert('SE9L'))));
    expect(read.holderOfKeyCertPem).toContain('SE9L');
    expect(read.holderOfKeyCertPem).not.toContain('QkVBUkVS');
  });

  it('picks the holder-of-key confirmation when a bearer one comes first (1.1)', () => {
    const read = readAssertion(saml1(sc1('bearer', cert('QkVBUkVS')) + sc1('holder-of-key', cert('SE9L'))));
    expect(read.holderOfKeyCertPem).toContain('SE9L');
  });

  it('does not report a certificate under a bearer confirmation', () => {
    expect(readAssertion(saml2(sc2('bearer', cert('QkVBUkVS')))).holderOfKeyCertPem).toBeUndefined();
    expect(readAssertion(saml1(sc1('bearer', cert('QkVBUkVS')))).holderOfKeyCertPem).toBeUndefined();
  });
});
