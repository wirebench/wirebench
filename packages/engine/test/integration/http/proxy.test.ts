import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpError } from '../../../src/errors.js';
import { sendHttp } from '../../../src/http/client.js';
import { ntlmHandshake } from '../../../src/http/auth/ntlm-transport.js';
import { resolveProxyFor } from '../../../src/http/proxy.js';
import type { HttpRequest } from '../../../src/http/types.js';
import { generateServerCert, generateTestCa, type TestCertificate } from '../../helpers/test-certs.js';
import { startNtlmServer, type NtlmServer } from '../../helpers/ntlm-server.js';
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
const ntlmServers: NtlmServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(ntlmServers.splice(0).map((server) => server.close()));
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
});

async function startPlain(): Promise<TestSoapServer> {
  const server = await startTestSoapServer();
  servers.push(server);
  return server;
}

async function startTls(): Promise<TestSoapServer> {
  const server = await startTestSoapServer({
    tls: { cert: serverCert.certPem, key: serverCert.keyPem, ca: ca.certPem },
  });
  servers.push(server);
  return server;
}

async function startProxy(...args: Parameters<typeof startTestProxy>): Promise<TestProxy> {
  const proxy = await startTestProxy(...args);
  proxies.push(proxy);
  return proxy;
}

function req(overrides: Partial<HttpRequest> & { url: string }): HttpRequest {
  return { method: 'GET', headers: {}, timeoutMs: 5000, followRedirects: false, ...overrides };
}

describe('sendHttp through a proxy', () => {
  it('forwards a plain HTTP request through the proxy, which observes it', async () => {
    const server = await startPlain();
    const proxy = await startProxy();

    const exchange = await sendHttp(req({ url: `${server.url}/headers`, proxy: { url: proxy.url } }));

    expect(exchange.status).toBe(200);
    expect(proxy.requests).toHaveLength(1);
    expect(proxy.requests[0]?.method).toBe('GET');
    expect(proxy.requests[0]?.target).toBe(`${server.url}/headers`);
    // The origin server still saw the request, i.e. the proxy really forwarded it.
    expect(server.requests).toHaveLength(1);
  });

  it('tunnels an HTTPS request with CONNECT and keeps TLS end to end', async () => {
    const server = await startTls();
    const proxy = await startProxy();

    const exchange = await sendHttp(
      req({ url: `${server.url}/headers`, proxy: { url: proxy.url }, tls: { ca: [ca.certPem] } }),
    );

    expect(exchange.status).toBe(200);
    expect(proxy.tunnelCount()).toBe(1);
    expect(proxy.requests[0]?.method).toBe('CONNECT');
    // The proxy only ever saw `host:port`; the TLS session terminated at the origin, so the
    // chain the client verified is the origin's own.
    expect(proxy.requests[0]?.target).toBe(`127.0.0.1:${new URL(server.url).port}`);
    expect(exchange.tls?.authorized).toBe(true);
    expect(exchange.tls?.peerChain[0]?.subject).toContain('CN=localhost');
  });

  it('bypasses the proxy for an excluded host', async () => {
    const server = await startPlain();
    const proxy = await startProxy();
    const config = { mode: 'manual', host: '127.0.0.1', port: proxy.port, excludes: ['localhost'] } as const;

    // A host outside the exclude list still resolves to the proxy — otherwise this test
    // would pass even with a config that proxies nothing at all.
    expect(resolveProxyFor('http://api.corp.test/x', config)).toEqual({ url: `http://127.0.0.1:${proxy.port}` });
    const bypassed = resolveProxyFor(server.url, config);
    expect(bypassed).toBeUndefined();

    const exchange = await sendHttp(
      req({ url: `${server.url}/headers`, ...(bypassed !== undefined ? { proxy: bypassed } : {}) }),
    );

    expect(exchange.status).toBe(200);
    expect(proxy.requests).toHaveLength(0);
    expect(server.requests).toHaveLength(1);
  });

  it('authenticates to the proxy with Proxy-Authorization: Basic', async () => {
    const server = await startPlain();
    const proxy = await startProxy({ requireAuth: { username: 'proxyuser', password: 'proxypass' } });

    const exchange = await sendHttp(
      req({
        url: `${server.url}/headers`,
        proxy: { url: proxy.url, auth: { username: 'proxyuser', password: 'proxypass' } },
      }),
    );

    expect(exchange.status).toBe(200);
    expect(proxy.requests[0]?.proxyAuthorization).toBe(
      `Basic ${Buffer.from('proxyuser:proxypass').toString('base64')}`,
    );
  });

  it('fails with a `proxy` error, and never reaches the origin, when the credentials are wrong', async () => {
    const server = await startPlain();
    const proxy = await startProxy({ requireAuth: { username: 'proxyuser', password: 'proxypass' } });

    const error = await sendHttp(
      req({ url: `${server.url}/headers`, proxy: { url: proxy.url, auth: { username: 'u', password: 'bad' } } }),
    ).catch((err: unknown) => err);

    // undici raises the proxy's 407 rather than handing it back as a response, so the user sees
    // a proxy problem — which is the truth — instead of a bewildering 407 from "the server".
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).code).toBe('proxy');
    expect(proxy.requests[0]?.proxyAuthorization).toBe(`Basic ${Buffer.from('u:bad').toString('base64')}`);
    expect(server.requests).toHaveLength(0);
  });

  it('reports a `proxy` HttpError when the proxy itself refuses the connection', async () => {
    const server = await startPlain();
    const proxy = await startProxy();
    const deadPort = proxy.port;
    await proxy.close();
    proxies.splice(proxies.indexOf(proxy), 1);

    const error = await sendHttp(
      req({ url: `${server.url}/headers`, proxy: { url: `http://127.0.0.1:${deadPort}` } }),
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).code).toBe('proxy');
  });

  it('completes an NTLM handshake through a CONNECT tunnel on one connection', async () => {
    // Deferred from the NTLM task: NTLM authenticates the *connection*, so all three legs must
    // ride the same socket — through a proxy that means one tunnel, not three.
    const ntlm = await startNtlmServer({ username: 'user', password: 'pass', domain: 'WORKGROUP' });
    ntlmServers.push(ntlm);
    const proxy = await startProxy();

    const result = await ntlmHandshake(
      req({
        url: `${ntlm.url}/`,
        method: 'POST',
        body: new TextEncoder().encode('<x/>'),
        proxy: { url: proxy.url },
      }),
      { username: 'user', password: 'pass', domain: 'WORKGROUP' },
    );

    expect(result.http.status).toBe(200);
    expect(result.challenged).toBe(true);
    expect(result.attempts).toBe(3);
    expect(proxy.requests.length).toBeGreaterThanOrEqual(3);
    expect(proxy.requests.every((entry) => entry.method === 'POST')).toBe(true);
  });
});
