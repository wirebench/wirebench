import { describe, expect, it } from 'vitest';
import { applyOutgoingWss } from '../../../../src/wss/apply.js';
import { verifySignature } from '../../../../src/wss/outgoing/signature.js';
import { createWssContext, SAML_TOKEN_PART } from '../../../../src/wss/model.js';
import { generateSigningCert, generateTestCa } from '../../../helpers/test-certs.js';
import type { Keystore } from '../../../../src/keystore/model.js';
import type { WssOutgoingConfig } from '../../../../src/wss/model.js';

const ca = generateTestCa();
const user = generateSigningCert(ca);
const keystore = {
  type: 'pem',
  aliases: [{ alias: 'me', certPem: user.certPem, keyPem: user.keyPem, chainPem: [] }],
} as unknown as Keystore;
const SOAP11 =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><Ping/></soapenv:Body></soapenv:Envelope>';
const ASSERTION =
  '<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1" Version="2.0" IssueInstant="2026-10-05T10:00:00Z">' +
  '<saml2:Issuer>urn:sts</saml2:Issuer></saml2:Assertion>';

function ctx() {
  let n = 0;
  return createWssContext({
    keystores: () => Promise.resolve(keystore),
    uuid: () => `u${String((n += 1))}`,
    clock: () => new Date('2026-10-05T10:00:00Z'),
  });
}

const senderVouches: WssOutgoingConfig = {
  id: 'w1',
  name: 'SV',
  mustUnderstand: false,
  entries: [
    { kind: 'saml-token', source: 'xml', xml: ASSERTION, expandProperties: false },
    {
      kind: 'signature',
      keystoreRef: 'ks',
      keyIdentifierType: 'BinarySecurityToken',
      signatureAlgorithm: 'rsa-sha256',
      digestAlgorithm: 'sha256',
      canonicalization: 'exc-c14n',
      useSingleCertificate: true,
      parts: [
        { name: 'Body', namespace: 'http://schemas.xmlsoap.org/soap/envelope/', encode: 'Content' },
        SAML_TOKEN_PART,
      ],
    },
  ],
};

describe('the STR-Transform', () => {
  it('covers the assertion through an STR, with TransformationParameters, and verifies', async () => {
    const xml = await applyOutgoingWss(SOAP11, senderVouches, ctx());
    expect(xml).toContain('#STR-Transform"><wsse:TransformationParameters');
    expect(xml).toContain('Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/></wsse:TransformationParameters>');
    expect(xml).not.toMatch(/<saml2:Assertion[^>]*wsu:Id/);
    expect(verifySignature(xml, { certPem: user.certPem }).ok).toBe(true);
  });

  it('fails verification when the assertion is altered after signing', async () => {
    const xml = await applyOutgoingWss(SOAP11, senderVouches, ctx());
    expect(verifySignature(xml.replace('urn:sts', 'urn:evil'), { certPem: user.certPem }).ok).toBe(false);
  });

  it('refuses to dereference when two assertions share the id (wrapping)', async () => {
    const xml = await applyOutgoingWss(SOAP11, senderVouches, ctx());
    // In the Header, outside every signed part: only the dereference's own uniqueness check can
    // catch it (inside the Body, the Body's digest would fail first and prove nothing).
    const wrapped = xml.replace('<soapenv:Header>', `<soapenv:Header>${ASSERTION}`);
    const result = verifySignature(wrapped, { certPem: user.certPem });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/matches 2 tokens/);
  });

  it('fails verification when the KeyIdentifier naming the token is emptied', async () => {
    const xml = await applyOutgoingWss(SOAP11, senderVouches, ctx());
    const emptied = xml.replace(/(<wsse:KeyIdentifier[^>]*>)_a1(<\/wsse:KeyIdentifier>)/, '$1$2');
    expect(emptied).not.toBe(xml);
    expect(verifySignature(emptied, { certPem: user.certPem }).ok).toBe(false);
  });

  it('refuses at signing, with a WssError, when two saml-token entries carry the same assertion', async () => {
    const [token, sig] = senderVouches.entries;
    const twice: WssOutgoingConfig = { ...senderVouches, entries: [token!, token!, sig!] };
    await expect(applyOutgoingWss(SOAP11, twice, ctx())).rejects.toMatchObject({
      name: 'WssError',
      code: 'wss-saml-token-missing',
      details: { configuration: 'SV', entry: 2 },
    });
  });

  it('refuses at signing when the attached reference names no plain assertion in the message', async () => {
    const attached =
      '<wsse:SecurityTokenReference xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">' +
      '<wsse:KeyIdentifier ValueType="urn:attached">_inner</wsse:KeyIdentifier></wsse:SecurityTokenReference>';
    const context = createWssContext({
      keystores: () => Promise.resolve(keystore),
      uuid: () => 'u',
      clock: () => new Date('2026-10-05T10:00:00Z'),
      issuedTokens: {
        get: () =>
          Promise.resolve({
            assertionXml: '<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="_outer"/>',
            assertionId: '_outer',
            attachedReferenceXml: attached,
            samlVersion: '2.0',
            keyType: 'bearer',
            stsHost: 'sts.test',
            cacheKey: 'k',
          }),
        peek: () => undefined,
      },
    });
    const [, sig] = senderVouches.entries;
    const config: WssOutgoingConfig = {
      ...senderVouches,
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
        sig!,
      ],
    };
    await expect(applyOutgoingWss(SOAP11, config, context)).rejects.toMatchObject({
      code: 'wss-saml-token-missing',
      details: { configuration: 'SV', entry: 1 },
    });
  });
});
