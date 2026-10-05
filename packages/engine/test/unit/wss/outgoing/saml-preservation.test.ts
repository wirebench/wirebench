import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SignedXml } from 'xml-crypto';
import { describe, expect, it } from 'vitest';
import { applyOutgoingWss } from '../../../../src/wss/apply.js';
import { createWssContext, SAML_TOKEN_PART } from '../../../../src/wss/model.js';
import { parseXml } from '../../../../src/xml/parse.js';
import { serializeXml } from '../../../../src/xml/serialize.js';
import { generateSigningCert, generateTestCa } from '../../../helpers/test-certs.js';
import type { Keystore } from '../../../../src/keystore/model.js';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/saml/${name}`, import.meta.url)), 'utf8');
const issuerCert = fixture('issuer-cert.pem');
const ca = generateTestCa();
const user = generateSigningCert(ca);
const keystore = {
  type: 'pem',
  aliases: [{ alias: 'me', certPem: user.certPem, keyPem: user.keyPem, chainPem: [] }],
} as unknown as Keystore;
const SOAP11 =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><Ping/></soapenv:Body></soapenv:Envelope>';

/** Verifies the assertion's own (issuer) signature as it now sits inside the envelope. */
function issuerSignatureHolds(envelope: string, version: '2.0' | '1.1'): boolean {
  const doc = parseXml(envelope, { location: 'envelope' });
  const namespace =
    version === '2.0' ? 'urn:oasis:names:tc:SAML:2.0:assertion' : 'urn:oasis:names:tc:SAML:1.0:assertion';
  const assertion = doc.getElementsByTagNameNS(namespace, 'Assertion').item(0)!;
  const signature = assertion.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature').item(0)!;
  // xml-crypto already treats `ID` as an id attribute, so only 1.1 needs `AssertionID` added.
  const verifier = new SignedXml({
    publicCert: issuerCert,
    ...(version === '1.1' ? { idAttribute: 'AssertionID' } : {}),
    getCertFromKeyInfo: () => null,
  });
  verifier.loadSignature(serializeXml(signature));
  return verifier.checkSignature(serializeXml(assertion));
}

describe.each(['2.0', '1.1'] as const)('an STS-signed SAML %s assertion', (version) => {
  it('keeps its issuer signature after placement and a message signature over it', async () => {
    let n = 0;
    const xml = await applyOutgoingWss(
      SOAP11,
      {
        id: 'w1',
        name: 'x',
        mustUnderstand: false,
        entries: [
          { kind: 'saml-token', source: 'xml', xml: fixture(`assertion-${version}.xml`), expandProperties: false },
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
    expect(issuerSignatureHolds(xml, version)).toBe(true);
  });
});
