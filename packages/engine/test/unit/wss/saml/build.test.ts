import { SignedXml } from 'xml-crypto';
import { describe, expect, it } from 'vitest';
import { buildSamlAssertion } from '../../../../src/wss/saml/build.js';
import { readAssertion } from '../../../../src/wss/saml/read.js';
import { generateSigningCert, generateTestCa } from '../../../helpers/test-certs.js';
import type { KeystoreAlias } from '../../../../src/keystore/model.js';
import type { WssSamlFormEntry } from '../../../../src/wss/model.js';

const ca = generateTestCa();
const issuerCert = generateSigningCert(ca);
const alias = {
  alias: 'issuer',
  certPem: issuerCert.certPem,
  keyPem: issuerCert.keyPem,
  chainPem: [ca.certPem],
} as unknown as KeystoreAlias;

const clock = () => new Date('2026-10-05T10:00:00.000Z');
const uuid = () => '1b2c';

function form(overrides: Partial<WssSamlFormEntry> = {}): WssSamlFormEntry {
  return {
    kind: 'saml-token',
    source: 'form',
    version: '2.0',
    issuer: 'urn:test:issuer',
    subject: 'alice',
    confirmation: 'bearer',
    audience: 'https://service.test/',
    lifetimeSeconds: 300,
    attributes: [{ name: 'role', values: ['admin', 'ops'] }],
    ...overrides,
  };
}

const signed = form({ sign: { keystoreRef: 'ks', signatureAlgorithm: 'rsa-sha256' } });

describe('buildSamlAssertion', () => {
  it('builds a SAML 2.0 bearer assertion with the clock and uuid it is given', () => {
    const xml = buildSamlAssertion(form(), { clock, uuid });
    expect(readAssertion(xml)).toMatchObject({ version: '2.0', id: '_1b2c' });
    expect(xml).toContain('IssueInstant="2026-10-05T10:00:00.000Z"');
    expect(xml).toContain('NotBefore="2026-10-05T09:59:00.000Z"');
    expect(xml).toContain('NotOnOrAfter="2026-10-05T10:05:00.000Z"');
    expect(xml).toContain('Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"');
    expect(xml).toContain('<saml2:Audience>https://service.test/</saml2:Audience>');
    expect(xml).toContain('<saml2:AttributeValue>ops</saml2:AttributeValue>');
  });

  it('treats an empty subject format, authentication context and attribute format as unset', () => {
    const blank = form({
      subjectFormat: '',
      authnContext: '',
      attributes: [{ name: 'role', nameFormat: '', values: ['a'] }],
    });
    const two = buildSamlAssertion(blank, { clock, uuid });
    expect(two).toContain('<saml2:NameID>alice</saml2:NameID>');
    expect(two).not.toContain('Format=""');
    expect(two).toContain(
      '<saml2:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:unspecified</saml2:AuthnContextClassRef>',
    );
    const one = buildSamlAssertion({ ...blank, version: '1.1' }, { clock, uuid });
    expect(one).toContain('<saml:NameIdentifier>alice</saml:NameIdentifier>');
    expect(one).toContain('AuthenticationMethod="urn:oasis:names:tc:SAML:1.0:am:unspecified"');
    expect(one).toContain('AttributeNamespace="urn:wirebench:attributes"');
  });

  it('builds a SAML 1.1 assertion with AssertionID', () => {
    const xml = buildSamlAssertion(form({ version: '1.1' }), { clock, uuid });
    expect(readAssertion(xml)).toMatchObject({ version: '1.1', id: '_1b2c' });
    expect(xml).toContain('<saml:ConfirmationMethod>urn:oasis:names:tc:SAML:1.0:cm:bearer</saml:ConfirmationMethod>');
  });

  it('escapes field text', () => {
    const xml = buildSamlAssertion(form({ subject: 'a<b&"c' }), { clock, uuid });
    expect(xml).toContain('a&lt;b&amp;"c');
  });

  it('puts the proof certificate into a holder-of-key confirmation', () => {
    const xml = buildSamlAssertion(form({ confirmation: 'holder-of-key' }), {
      clock,
      uuid,
      proofCertPem: issuerCert.certPem,
    });
    expect(readAssertion(xml).holderOfKeyCertPem?.replace(/\s/g, '')).toBe(issuerCert.certPem.replace(/\s/g, ''));
  });

  it('signs the assertion as its issuer with an enveloped signature over ID', () => {
    const xml = buildSamlAssertion(signed, { clock, uuid, signing: { alias } });
    const verifier = new SignedXml({
      publicCert: issuerCert.certPem,
      getCertFromKeyInfo: () => null,
    });
    const signature = /<ds:Signature[\s\S]*<\/ds:Signature>/.exec(xml)?.[0] ?? '';
    verifier.loadSignature(signature);
    expect(verifier.checkSignature(xml)).toBe(true);
  });

  it('signs a SAML 1.1 assertion over AssertionID, signature last', () => {
    const xml = buildSamlAssertion({ ...signed, version: '1.1' }, { clock, uuid, signing: { alias } });
    const verifier = new SignedXml({
      publicCert: issuerCert.certPem,
      idAttribute: 'AssertionID',
      getCertFromKeyInfo: () => null,
    });
    verifier.loadSignature(/<ds:Signature[\s\S]*<\/ds:Signature>/.exec(xml)?.[0] ?? '');
    expect(verifier.checkSignature(xml)).toBe(true);
    expect(xml.endsWith('</ds:Signature></saml:Assertion>')).toBe(true);
  });

  it.each(['2.0', '1.1'] as const)("references the assertion's own id, adding no Id attribute (%s)", (version) => {
    const xml = buildSamlAssertion({ ...signed, version }, { clock, uuid, signing: { alias } });
    expect(xml).toContain('<ds:Reference URI="#_1b2c">');
    const root = /^<[^>]*>/.exec(xml)?.[0] ?? '';
    expect(root).not.toMatch(/ Id=/);
  });

  it('places the issuer signature right after saml2:Issuer, as the schema requires', () => {
    const xml = buildSamlAssertion(signed, { clock, uuid, signing: { alias } });
    expect(xml.indexOf('</saml2:Issuer>')).toBeLessThan(xml.indexOf('<ds:Signature'));
    expect(xml.indexOf('<ds:Signature')).toBeLessThan(xml.indexOf('<saml2:Subject>'));
  });
});
