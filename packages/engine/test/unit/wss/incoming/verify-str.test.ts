import { describe, expect, it } from 'vitest';
import { applyOutgoingWss } from '../../../../src/wss/apply.js';
import { verifyIncoming } from '../../../../src/wss/incoming/verify.js';
import { createWssContext, SAML_TOKEN_PART } from '../../../../src/wss/model.js';
import { generateSigningCert, generateTestCa } from '../../../helpers/test-certs.js';
import type { Keystore } from '../../../../src/keystore/model.js';

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

async function senderVouches(): Promise<string> {
  let n = 0;
  return applyOutgoingWss(
    SOAP11,
    {
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
    },
    createWssContext({ keystores: () => Promise.resolve(keystore), uuid: () => `u${String((n += 1))}` }),
  );
}

describe('verifying a signature that covers a SAML token through the STR-Transform', () => {
  it('passes and lists the STR among its references', async () => {
    const xml = await senderVouches();
    const result = verifyIncoming(xml, {
      truststore: keystore,
      clock: () => new Date(),
      skewSeconds: 300,
      verifyChain: false,
    });
    expect(result.signatures).toHaveLength(1);
    const signature = result.signatures[0]!;
    expect(signature.error).toBeUndefined();
    expect(signature.ok).toBe(true);
    expect(signature.trusted).toBe(true);
    expect(signature.references.some((id) => id.startsWith('STR-'))).toBe(true);
    expect(signature.coversBody).toBe(true);
  });

  it('fails once the assertion is altered', async () => {
    const xml = (await senderVouches()).replace('urn:sts', 'urn:evil');
    const result = verifyIncoming(xml, {
      truststore: keystore,
      clock: () => new Date(),
      skewSeconds: 300,
      verifyChain: false,
    });
    expect(result.signatures[0]?.ok).toBe(false);
  });
});
