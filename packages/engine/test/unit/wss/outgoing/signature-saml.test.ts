// packages/engine/test/unit/wss/outgoing/signature-saml.test.ts
import { describe, expect, it } from 'vitest';
import { applyOutgoingWss } from '../../../../src/wss/apply.js';
import { verifySignature } from '../../../../src/wss/outgoing/signature.js';
import { createWssContext, SAML_TOKEN_PART } from '../../../../src/wss/model.js';
import { generateClientCert, generateSigningCert, generateTestCa } from '../../../helpers/test-certs.js';
import type { Keystore } from '../../../../src/keystore/model.js';
import type { WssContext, WssOutgoingConfig, WssSignatureEntry } from '../../../../src/wss/model.js';

const ca = generateTestCa();
const user = generateSigningCert(ca);
// generateSigningCert is memoised, so a second distinct identity comes from the client cert.
const other = generateClientCert(ca);
const keystore = (cert: { certPem: string; keyPem: string }): Keystore =>
  ({
    type: 'pem',
    aliases: [{ alias: 'me', certPem: cert.certPem, keyPem: cert.keyPem, chainPem: [], hasPrivateKey: true }],
  }) as unknown as Keystore;

const SOAP11 =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><Ping/></soapenv:Body></soapenv:Envelope>';

function signature(overrides: Partial<WssSignatureEntry> = {}): WssSignatureEntry {
  return {
    kind: 'signature',
    keystoreRef: 'user',
    keyIdentifierType: 'saml-token',
    signatureAlgorithm: 'rsa-sha256',
    digestAlgorithm: 'sha256',
    canonicalization: 'exc-c14n',
    useSingleCertificate: true,
    parts: [{ name: 'Body', namespace: 'http://schemas.xmlsoap.org/soap/envelope/', encode: 'Content' }],
    ...overrides,
  };
}

function context(overrides: Partial<WssContext> = {}): WssContext {
  let n = 0;
  return createWssContext({
    keystores: (ref) => Promise.resolve(keystore(ref === 'other' ? other : user)),
    clock: () => new Date('2026-10-05T10:00:00Z'),
    uuid: () => `u${String((n += 1))}`,
    ...overrides,
  });
}

function holderOfKey(proofKeystoreRef: string, signingKeystoreRef: string): WssOutgoingConfig {
  return {
    id: 'w1',
    name: 'HoK',
    mustUnderstand: false,
    entries: [
      {
        kind: 'saml-token',
        source: 'form',
        version: '2.0',
        issuer: 'urn:i',
        subject: 'alice',
        confirmation: 'holder-of-key',
        lifetimeSeconds: 300,
        attributes: [],
        proofKeystoreRef,
      },
      signature({ keystoreRef: signingKeystoreRef }),
    ],
  };
}

describe('the saml-token key identifier', () => {
  it('puts an STR naming the assertion by SAMLID into KeyInfo, and the signature verifies', async () => {
    const xml = await applyOutgoingWss(SOAP11, holderOfKey('user', 'user'), context());
    expect(xml).toMatch(/<ds:KeyInfo>.*<wsse:SecurityTokenReference[^>]*wsse11:TokenType="[^"]*#SAMLV2\.0"/s);
    expect(xml).toMatch(/ValueType="[^"]*#SAMLID"[^>]*>_u\d+<\/wsse:KeyIdentifier>/);
    expect(verifySignature(xml, { certPem: user.certPem }).ok).toBe(true);
  });

  it('also covers the holder-of-key token itself through the STR-Transform, and verifies', async () => {
    const config = holderOfKey('user', 'user');
    const [token, sig] = config.entries;
    const signed: WssOutgoingConfig = {
      ...config,
      entries: [
        token!,
        { ...(sig as WssSignatureEntry), parts: [...(sig as WssSignatureEntry).parts, SAML_TOKEN_PART] },
      ],
    };
    const xml = await applyOutgoingWss(SOAP11, signed, context());
    expect(xml).toContain('#STR-Transform"><wsse:TransformationParameters');
    expect(xml).not.toMatch(/<saml2:Assertion[^>]*wsu:Id/);
    expect(verifySignature(xml, { certPem: user.certPem }).ok).toBe(true);
  });

  it('refuses a holder-of-key signature made with a key other than the proof key', async () => {
    await expect(applyOutgoingWss(SOAP11, holderOfKey('user', 'other'), context())).rejects.toMatchObject({
      code: 'wss-proof-key-mismatch',
    });
  });

  it('refuses when no SAML entry comes before the signature', async () => {
    await expect(
      applyOutgoingWss(SOAP11, { id: 'w1', name: 'x', mustUnderstand: false, entries: [signature()] }, context()),
    ).rejects.toMatchObject({ code: 'wss-saml-token-missing' });
  });

  it("uses the RSTR's attached reference when the token brought one", async () => {
    const attached =
      '<wsse:SecurityTokenReference xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">' +
      '<wsse:KeyIdentifier ValueType="urn:attached">_given</wsse:KeyIdentifier></wsse:SecurityTokenReference>';
    const ctx = context({
      issuedTokens: {
        get: () =>
          Promise.resolve({
            assertionXml: '<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="_given"/>',
            assertionId: '_given',
            attachedReferenceXml: attached,
            samlVersion: '2.0',
            keyType: 'bearer',
            stsHost: 'sts.test',
            cacheKey: 'k',
          }),
        peek: () => undefined,
      },
    });
    const xml = await applyOutgoingWss(
      SOAP11,
      {
        id: 'w1',
        name: 'x',
        mustUnderstand: false,
        entries: [
          {
            kind: 'issued-token',
            stsUrl: 'https://sts.test',
            soapVersion: '1.2',
            trustVersion: '1.3',
            tokenType: '2.0',
            keyType: 'bearer',
            credential: { kind: 'username', username: 'a' },
            requestedLifetimeSeconds: 0,
          },
          signature(),
        ],
      },
      ctx,
    );
    expect(xml).toContain('ValueType="urn:attached"');
  });
});
