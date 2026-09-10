/**
 * The keystore loaders' contract with the outside world: what `toTlsClientIdentity` produces
 * must be accepted by Node's TLS stack as a real client identity, not merely parse.
 */

import forge from 'node-forge';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sendHttp } from '../../../src/http/client.js';
import { loadKeystore, toTlsClientIdentity } from '../../../src/wss/keystore/index.js';
import type { HttpRequest } from '../../../src/http/types.js';
import {
  generateClientCert,
  generateServerCert,
  generateTestCa,
  type TestCertificate,
} from '../../helpers/test-certs.js';
import { startTestSoapServer, type TestSoapServer } from '../../helpers/test-soap-server.js';

const PASSWORD = 'keystore-password';

let ca: TestCertificate;
let serverCert: TestCertificate;
let client: TestCertificate;

beforeAll(() => {
  ca = generateTestCa();
  serverCert = generateServerCert(ca, { commonName: 'localhost', sans: ['localhost', '127.0.0.1'] });
  client = generateClientCert(ca);
});

const servers: TestSoapServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function startMutualTls(): Promise<TestSoapServer> {
  const server = await startTestSoapServer({
    tls: { cert: serverCert.certPem, key: serverCert.keyPem, ca: ca.certPem, requestCert: true },
  });
  servers.push(server);
  return server;
}

function pkcs12Bytes(): Uint8Array {
  const asn1 = forge.pkcs12.toPkcs12Asn1(
    forge.pki.privateKeyFromPem(client.keyPem),
    [forge.pki.certificateFromPem(client.certPem), forge.pki.certificateFromPem(ca.certPem)],
    PASSWORD,
    { friendlyName: 'client', algorithm: '3des' },
  );
  return Uint8Array.from(Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary'));
}

async function tlsInfo(
  server: TestSoapServer,
  tls: HttpRequest['tls'],
): Promise<{ peerAuthorized: boolean; peerCN?: string }> {
  const exchange = await sendHttp({
    url: `${server.url}/tls-info`,
    method: 'GET',
    headers: {},
    timeoutMs: 5000,
    followRedirects: false,
    ...(tls === undefined ? {} : { tls }),
  });
  expect(exchange.status).toBe(200);
  return JSON.parse(Buffer.from(exchange.body).toString('utf-8')) as { peerAuthorized: boolean; peerCN?: string };
}

describe('a keystore identity on the wire', () => {
  it('is presented and verified when it comes from a PKCS#12', async () => {
    const server = await startMutualTls();
    const keystore = loadKeystore(pkcs12Bytes(), { type: 'pkcs12', password: PASSWORD });
    const identity = toTlsClientIdentity(keystore, 'client');

    // Server trust comes from the caller, never from the identity: `toTlsClientIdentity` returns
    // no `ca` precisely so that selecting a keystore cannot replace Node's trust store.
    const info = await tlsInfo(server, { cert: identity.cert, key: identity.key, ca: [ca.certPem] });

    expect(info.peerAuthorized).toBe(true);
    expect(info.peerCN).toBe('wirebench-client');
  });

  it('is presented and verified when it comes from a PEM bundle', async () => {
    const server = await startMutualTls();
    const bundle = new TextEncoder().encode(`${client.certPem}\n${ca.certPem}\n${client.keyPem}`);
    const identity = toTlsClientIdentity(loadKeystore(bundle, { type: 'pem' }));

    const info = await tlsInfo(server, { cert: identity.cert, key: identity.key, ca: [ca.certPem] });

    expect(info.peerAuthorized).toBe(true);
    expect(info.peerCN).toBe('wirebench-client');
  });
});
