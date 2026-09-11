/**
 * The one ordering rule that is not a matter of taste: a WS-Security signature must cover the
 * envelope that actually goes on the wire.
 *
 * Inline `file:` references used to be substituted *after* the signature was computed, so the
 * digest covered the literal `file:/…` text and the receiver — verifying over the base64 that
 * replaced it — could never make the signature check out. This test signs a body holding a
 * `file:` reference, sends it to the echo server, and verifies the signature against what came
 * back.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { sendSoapRequest } from '../../../src/send.js';
import { createWssContext } from '../../../src/wss/model.js';
import { verifySignature } from '../../../src/wss/outgoing/signature.js';
import { NS } from '../../../src/xml/namespaces.js';
import type { Keystore, KeystoreAlias } from '../../../src/wss/keystore/model.js';
import type { WssPart, WssSignatureEntry } from '../../../src/wss/model.js';
import { generateSigningCert, generateTestCa } from '../../helpers/test-certs.js';
import { startTestSoapServer, type TestSoapServer } from '../../helpers/test-soap-server.js';

const servers: TestSoapServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const ca = generateTestCa();
const signer = generateSigningCert(ca);

const FILE_BYTES = new TextEncoder().encode('the attachment payload');
const FILE_BASE64 = Buffer.from(FILE_BYTES).toString('base64');

const ENVELOPE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
  '<soapenv:Body><tns:Echo xmlns:tns="urn:test"><tns:Payload>file:/payload.bin</tns:Payload></tns:Echo></soapenv:Body>' +
  '</soapenv:Envelope>';

function keystore(): Keystore {
  const alias: KeystoreAlias = {
    alias: 'signer',
    certPem: signer.certPem,
    keyPem: signer.keyPem,
    chainPem: [ca.certPem],
    subject: 'CN=signer',
    issuer: 'CN=ca',
    notBefore: '2026-01-01T00:00:00.000Z',
    notAfter: '2027-01-01T00:00:00.000Z',
    serial: '01',
    fingerprintSha256: 'AA:BB',
    hasPrivateKey: true,
  };
  return { type: 'pem', aliases: [alias] };
}

const BODY_PART: WssPart = { name: 'Body', namespace: NS.SOAP11_ENV, encode: 'Content' };

const SIGNATURE: WssSignatureEntry = {
  kind: 'signature',
  keystoreRef: 'ks-1',
  keyIdentifierType: 'BinarySecurityToken',
  signatureAlgorithm: 'rsa-sha256',
  digestAlgorithm: 'sha256',
  canonicalization: 'exc-c14n',
  useSingleCertificate: true,
  parts: [BODY_PART],
};

describe('inline files and WS-Security', () => {
  it('signs the substituted base64, so the signature verifies over what was sent', async () => {
    const server = await startTestSoapServer();
    servers.push(server);

    const exchange = await sendSoapRequest({
      endpoint: `${server.url}/soap`,
      envelopeXml: ENVELOPE,
      soapVersion: '1.1',
      attachmentOptions: {
        enableMtom: false,
        forceMtom: false,
        disableMultiparts: false,
        encodeAttachments: false,
        inlineResponseAttachments: false,
        expandMtomAttachments: false,
        resolver: () => Promise.resolve(new Uint8Array()),
        enableInlineFiles: true,
        resolveFile: (path: string) => {
          expect(path).toBe('/payload.bin');
          return Promise.resolve(FILE_BYTES);
        },
      },
      wss: {
        outgoing: { id: 'w1', name: 'Outgoing', mustUnderstand: false, entries: [SIGNATURE] },
        ctx: createWssContext({ keystores: () => Promise.resolve(keystore()) }),
      },
    });

    const raw = server.requests.at(-1)?.body;
    const sent = raw === undefined ? '' : new TextDecoder().decode(raw);
    expect(sent).toContain(FILE_BASE64);
    expect(sent).not.toContain('file:/payload.bin');

    const echoed = exchange.response?.envelopeXml ?? '';
    expect(echoed).toContain('ds:Signature');
    const verified = verifySignature(echoed, { certPem: signer.certPem });
    expect(verified.error).toBeUndefined();
    expect(verified.ok).toBe(true);
  });
});
