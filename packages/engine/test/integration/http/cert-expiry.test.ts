import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { probeTlsChain } from '../../../src/http/cert-expiry.js';
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

async function startTls(): Promise<{ readonly port: number; readonly requests: () => number }> {
  const server = await startTestSoapServer({ tls: { cert: serverCert.certPem, key: serverCert.keyPem } });
  servers.push(server);
  return { port: Number(new URL(server.url).port), requests: () => server.requests.length };
}

describe('probeTlsChain', () => {
  it('reads the presented chain from a handshake alone, sending no request', async () => {
    const server = await startTls();

    const info = await probeTlsChain({ host: 'localhost', port: server.port });

    expect(info.peerChain[0]?.subject).toContain('CN=localhost');
    expect(info.servername).toBe('localhost');
    // Not trusted by Node's defaults, and reported rather than refused.
    expect(info.authorized).toBe(false);
    expect(server.requests()).toBe(0);
  });

  it('judges trust against the anchors it is given', async () => {
    const server = await startTls();

    const info = await probeTlsChain({ host: 'localhost', port: server.port }, { ca: [ca.certPem] });

    expect(info.authorized).toBe(true);
  });

  it('sends no SNI to an IP literal', async () => {
    const server = await startTls();

    const info = await probeTlsChain({ host: '127.0.0.1', port: server.port });

    expect(info.peerChain[0]?.subject).toContain('CN=localhost');
  });

  it('tunnels through the proxy a send would use', async () => {
    const server = await startTls();
    const proxy = await startTestProxy({ requireAuth: { username: 'u', password: 'p' } });
    proxies.push(proxy);

    const info = await probeTlsChain(
      { host: 'localhost', port: server.port },
      { proxy: { url: proxy.url, auth: { username: 'u', password: 'p' } } },
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
