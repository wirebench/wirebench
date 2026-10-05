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
