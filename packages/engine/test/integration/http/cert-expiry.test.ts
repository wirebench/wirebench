import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import forge from 'node-forge';
import { isCertificateVerifyError, probeTlsChain } from '../../../src/http/cert-expiry.js';
import { generateServerCert, generateTestCa, type TestCertificate } from '../../helpers/test-certs.js';
import { startTestProxy, type TestProxy } from '../../helpers/test-proxy.js';
import { startTestSoapServer, type TestSoapServer } from '../../helpers/test-soap-server.js';

let ca: TestCertificate;
let serverCert: TestCertificate;

beforeAll(() => {
  ca = generateTestCa();
  serverCert = generateServerCert(ca, { commonName: 'localhost', sans: ['localhost', '127.0.0.1'] });
});

const servers: TestSoapServer[] = [];
const proxies: TestProxy[] = [];
const silent: Server[] = [];
const accepted: Socket[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  for (const socket of accepted.splice(0)) socket.destroy();
  await Promise.all(
    silent.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

/** A `localhost` certificate issued by `ca` that ran out yesterday. */
function expiredServerCert(): TestCertificate {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '0badc0de';
  cert.validity.notBefore = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() - 24 * 60 * 60 * 1000);
  cert.setSubject([{ name: 'commonName', value: 'localhost' }]);
  cert.setIssuer(forge.pki.certificateFromPem(ca.certPem).subject.attributes);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }]);
  cert.sign(forge.pki.privateKeyFromPem(ca.keyPem), forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

async function startTls(
  leaf: TestCertificate = serverCert,
): Promise<{ readonly port: number; readonly requests: () => number }> {
  const server = await startTestSoapServer({ tls: { cert: leaf.certPem, key: leaf.keyPem } });
  servers.push(server);
  return { port: Number(new URL(server.url).port), requests: () => server.requests.length };
}

describe('probeTlsChain', () => {
  it('reads the presented chain from a handshake alone, sending no request', async () => {
    const server = await startTls();

    const info = await probeTlsChain({ host: 'localhost', port: server.port }, { ca: [ca.certPem] });

    expect(info.peerChain[0]?.subject).toContain('CN=localhost');
    expect(info.servername).toBe('localhost');
    expect(info.authorized).toBe(true);
    expect(server.requests()).toBe(0);
  });

  it('verifies the chain as a send does, failing with the reason when it does not', async () => {
    const server = await startTls();

    const error: unknown = await probeTlsChain({ host: 'localhost', port: server.port }).catch(
      (caught: unknown) => caught,
    );

    expect(isCertificateVerifyError(error)).toBe(true);
    expect((error as { code: string }).code).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED/);
    expect(server.requests()).toBe(0);
  });

  it('fails an expired certificate with CERT_HAS_EXPIRED', async () => {
    const server = await startTls(expiredServerCert());

    const error: unknown = await probeTlsChain({ host: 'localhost', port: server.port }, { ca: [ca.certPem] }).catch(
      (caught: unknown) => caught,
    );

    expect(isCertificateVerifyError(error)).toBe(true);
    expect((error as { code: string }).code).toBe('CERT_HAS_EXPIRED');
  });

  it('checks the host name, so an IP literal the certificate names verifies', async () => {
    const server = await startTls();

    const info = await probeTlsChain({ host: '127.0.0.1', port: server.port }, { ca: [ca.certPem] });

    expect(info.peerChain[0]?.subject).toContain('CN=localhost');
  });

  it('tunnels through the proxy a send would use', async () => {
    const server = await startTls();
    const proxy = await startTestProxy({ requireAuth: { username: 'u', password: 'p' } });
    proxies.push(proxy);

    const info = await probeTlsChain(
      { host: 'localhost', port: server.port },
      { proxy: { url: proxy.url, auth: { username: 'u', password: 'p' } }, ca: [ca.certPem] },
    );

    expect(info.peerChain[0]?.subject).toContain('CN=localhost');
    expect(proxy.tunnelCount()).toBe(1);
  });

  it('fails naming the endpoint when the proxy refuses the tunnel', async () => {
    const server = await startTls();
    const proxy = await startTestProxy({ requireAuth: { username: 'u', password: 'p' } });
    proxies.push(proxy);

    await expect(
      probeTlsChain({ host: 'localhost', port: server.port }, { proxy: { url: proxy.url } }),
    ).rejects.toThrow(/refused the tunnel to localhost:\d+: HTTP 407/);
  });

  it('gives up after the timeout when the peer never answers the handshake', async () => {
    const server = createServer((socket) => {
      // Accepts the connection and never speaks; `afterEach` destroys it.
      accepted.push(socket);
    });
    silent.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    await expect(probeTlsChain({ host: '127.0.0.1', port }, { timeoutMs: 200 })).rejects.toThrow(
      /No TLS handshake with 127\.0\.0\.1:\d+ within 200 ms/,
    );
  });

  it('fails when nothing listens', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });

    await expect(probeTlsChain({ host: '127.0.0.1', port }, { timeoutMs: 2000 })).rejects.toThrow(/ECONNREFUSED/);
  });
});
