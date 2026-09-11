import { Agent } from 'undici';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpError } from '../../../src/errors.js';
import { sendHttp } from '../../../src/http/client.js';
import type { HttpExchange, HttpRequest } from '../../../src/http/types.js';
import { splitPemBundle } from '../../../src/http/tls.js';
import {
  generateClientCert,
  generateServerCert,
  generateTestCa,
  generateUntrustedCert,
  type TestCertificate,
} from '../../helpers/test-certs.js';
import { startTestSoapServer, type TestSoapServer } from '../../helpers/test-soap-server.js';

let ca: TestCertificate;
let serverCert: TestCertificate;
let clientCert: TestCertificate;

// Key generation is the only slow part; do it once for the whole file.
beforeAll(() => {
  ca = generateTestCa();
  serverCert = generateServerCert(ca, { commonName: 'localhost', sans: ['localhost', '127.0.0.1'] });
  clientCert = generateClientCert(ca);
});

const servers: TestSoapServer[] = [];
const dispatchers: Agent[] = [];

afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function startTls(extra?: {
  requestCert?: boolean;
  maxVersion?: 'TLSv1.2' | 'TLSv1.3';
  alpn?: readonly string[];
}): Promise<TestSoapServer> {
  const server = await startTestSoapServer({
    tls: {
      cert: serverCert.certPem,
      key: serverCert.keyPem,
      ca: ca.certPem,
      ...(extra?.requestCert !== undefined ? { requestCert: extra.requestCert } : {}),
      ...(extra?.maxVersion !== undefined ? { maxVersion: extra.maxVersion } : {}),
      ...(extra?.alpn !== undefined ? { alpnProtocols: extra.alpn } : {}),
    },
  });
  servers.push(server);
  return server;
}

function req(overrides: Partial<HttpRequest> & { url: string }): HttpRequest {
  return { method: 'POST', headers: {}, timeoutMs: 2000, followRedirects: false, ...overrides };
}

describe('sendHttp over TLS', () => {
  it('captures protocol, cipher and the peer chain when the CA is trusted', async () => {
    const server = await startTls();

    const exchange = await sendHttp(req({ url: `${server.url}/headers`, tls: { ca: [ca.certPem] } }));

    expect(exchange.status).toBe(200);
    expect(exchange.tls?.protocol).toBe('TLSv1.3');
    expect(exchange.tls?.cipher).toBeTruthy();
    expect(exchange.tls?.authorized).toBe(true);
    expect(exchange.tls?.authorizationError).toBeUndefined();

    const leaf = exchange.tls?.peerChain[0];
    expect(leaf?.subject).toContain('CN=localhost');
    expect(leaf?.issuer).toContain('CN=Wirebench Test CA');
    expect(leaf?.sans).toContain('127.0.0.1');
    expect(leaf?.fingerprint256).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(leaf?.validTo ?? '').getTime()).toBeGreaterThan(Date.now());
  });

  it('fails with a `tls-untrusted` HttpError, naming the peer, when the CA is not trusted', async () => {
    const server = await startTls();

    const error = await sendHttp(req({ url: `${server.url}/headers` })).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).code).toBe('tls-untrusted');
    expect(['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']).toContain(
      (error as HttpError).details?.['code'],
    );
    // undici's connector raises a bare coded Error with no certificate attached, so the peer is
    // named by host; `peerSubject` is filled in only when Node does hand back the certificate.
    expect((error as HttpError).details?.['host']).toBe(new URL(server.url).host);
    expect((error as HttpError).message).toContain('Trust invalid certificates');
  });

  it('reaches a private-CA server once its CA bundle is trusted', async () => {
    // The carry-over acceptance case: trust is configured, verification stays on.
    const server = await startTls();
    const bundle = splitPemBundle(`${ca.certPem}\n${generateUntrustedCert().certPem}`);

    const exchange = await sendHttp(req({ url: `${server.url}/headers`, tls: { ca: bundle } }));

    expect(bundle).toHaveLength(2);
    expect(exchange.status).toBe(200);
    expect(exchange.tls?.authorized).toBe(true);
  });

  it('passes when the endpoint opts into trusting an invalid certificate', async () => {
    const server = await startTls();

    const exchange = await sendHttp(req({ url: `${server.url}/headers`, tls: { rejectUnauthorized: false } }));

    expect(exchange.status).toBe(200);
    expect(exchange.tls?.authorized).toBe(false);
  });

  it('labels the exchange HTTP/2 when the server negotiates h2', async () => {
    const server = await startTls({ alpn: ['h2', 'http/1.1'] });

    const exchange = await sendHttp(req({ url: `${server.url}/headers`, tls: { ca: [ca.certPem] }, allowH2: true }));

    expect(exchange.status).toBe(200);
    expect(exchange.httpVersion).toBe('2');
    expect(Buffer.from(exchange.rawResponse).toString('utf-8')).toContain('HTTP/2 200');
  });

  it('stays on HTTP/1.1 when HTTP/2 is not offered', async () => {
    const server = await startTls();

    const exchange = await sendHttp(req({ url: `${server.url}/headers`, tls: { ca: [ca.certPem] } }));

    expect(exchange.httpVersion).toBe('1.1');
    expect(Buffer.from(exchange.rawResponse).toString('utf-8')).toContain('HTTP/1.1 200');
  });

  it('still reports the chain, unauthorized, when verification is switched off', async () => {
    const server = await startTls();

    const exchange = await sendHttp(req({ url: `${server.url}/headers`, tls: { rejectUnauthorized: false } }));

    expect(exchange.status).toBe(200);
    expect(exchange.tls?.authorized).toBe(false);
    expect(exchange.tls?.authorizationError).toBeTruthy();
    expect(exchange.tls?.peerChain.length).toBeGreaterThan(0);
  });

  it('carries the TLS info on a second request that reuses the keep-alive connection', async () => {
    const server = await startTls();
    const dispatcher = new Agent({ connect: { ca: [ca.certPem] } });
    dispatchers.push(dispatcher);

    // undici's pool warms a spare connection before it settles into reusing one, so
    // send until an exchange reports no connect of its own — that one is the reuse case.
    const exchanges = [];
    for (let i = 0; i < 4; i += 1) {
      exchanges.push(await sendHttp(req({ url: `${server.url}/headers` }), { dispatcher }));
    }
    const first = exchanges[0];
    const reused = exchanges.find((exchange) => exchange.timings.connectMs === undefined);

    expect(reused).toBeDefined();
    // No new socket was opened, so `undici:client:connected` never fired for it — and yet
    // `sendHeaders` still names the socket the bytes went out on.
    expect(reused?.tls?.protocol).toBe('TLSv1.3');
    expect(reused?.tls?.peerChain[0]?.fingerprint256).toBe(first?.tls?.peerChain[0]?.fingerprint256);
  });

  it('does not cross-attribute TLS info between concurrent exchanges to the SAME origin on different sockets', async () => {
    // Two more certs (both valid for `localhost`, so verification succeeds regardless of
    // which one SNICallback hands back) that the server alternates per handshake, so the
    // two sockets this test forces are distinguishable from the outside. The requests
    // below deliberately address the server as `localhost`, not `127.0.0.1`: SNI is only
    // sent for a DNS name, never for an IP-literal host (RFC 6066), so `SNICallback` — the
    // only per-connection lever `https.createServer` exposes — would otherwise never fire.
    const certA = generateServerCert(ca, { commonName: 'socket-a', sans: ['localhost', '127.0.0.1'] });
    const certB = generateServerCert(ca, { commonName: 'socket-b', sans: ['localhost', '127.0.0.1'] });
    const server = await startTestSoapServer({
      tls: {
        cert: certA.certPem,
        key: certA.keyPem,
        ca: ca.certPem,
        perConnectionCerts: [
          { cert: certA.certPem, key: certA.keyPem },
          { cert: certB.certPem, key: certB.keyPem },
        ],
      },
    });
    servers.push(server);
    const url = server.url.replace('127.0.0.1', 'localhost');
    // `connections: 2` forces two physical sockets for two concurrent requests to the
    // same origin instead of queueing the second behind the first; `pipelining: 1` keeps
    // each socket to one in-flight request so the pairing below is unambiguous.
    const dispatcher = new Agent({ connections: 2, pipelining: 1, connect: { ca: [ca.certPem] } });
    dispatchers.push(dispatcher);

    const [a, b] = await Promise.all([
      sendHttp(req({ url: `${url}/tls-info`, method: 'GET' }), { dispatcher }),
      sendHttp(req({ url: `${url}/tls-info`, method: 'GET' }), { dispatcher }),
    ]);

    const normalize = (fp: string): string => fp.replace(/:/g, '').toLowerCase();
    const bodyOf = (exchange: HttpExchange): { serverFingerprint: string } =>
      JSON.parse(Buffer.from(exchange.body).toString('utf-8')) as { serverFingerprint: string };

    const bodyA = bodyOf(a);
    const bodyB = bodyOf(b);
    // The two connections really did land on different certs — otherwise this test
    // would pass trivially, the very failure mode the bug produces.
    expect(bodyA.serverFingerprint).not.toBe(bodyB.serverFingerprint);

    expect(a.tls?.peerChain[0]?.fingerprint256).toBe(normalize(bodyA.serverFingerprint));
    expect(b.tls?.peerChain[0]?.fingerprint256).toBe(normalize(bodyB.serverFingerprint));
  });

  it('does not cross-attribute TLS info between concurrent exchanges to different origins', async () => {
    const otherCert = generateServerCert(ca, { commonName: 'other.test', sans: ['other.test', '127.0.0.1'] });
    const first = await startTls();
    const second = await startTestSoapServer({
      tls: { cert: otherCert.certPem, key: otherCert.keyPem, ca: ca.certPem },
    });
    servers.push(second);

    // Both in flight at once: the single-in-flight rule cannot help here, so the only thing
    // keeping the two chains apart is `sendHeaders`' request origin.
    const [a, b] = await Promise.all([
      sendHttp(req({ url: `${first.url}/headers`, tls: { ca: [ca.certPem] } })),
      sendHttp(req({ url: `${second.url}/headers`, tls: { ca: [ca.certPem] } })),
    ]);

    expect(a.tls?.peerChain[0]?.subject).toContain('CN=localhost');
    expect(b.tls?.peerChain[0]?.subject).toContain('CN=other.test');
  });

  it('presents a client certificate when one is configured', async () => {
    const server = await startTls({ requestCert: true });

    const exchange = await sendHttp(
      req({
        url: `${server.url}/tls-info`,
        method: 'GET',
        tls: { ca: [ca.certPem], cert: clientCert.certPem, key: clientCert.keyPem },
      }),
    );

    expect(exchange.status).toBe(200);
    const info = JSON.parse(Buffer.from(exchange.body).toString('utf-8')) as {
      peerAuthorized: boolean;
      peerCN?: string;
    };
    expect(info.peerAuthorized).toBe(true);
    expect(info.peerCN).toBe('wirebench-client');
  });

  it('honours minVersion: a TLSv1.3-only client will not talk to a TLSv1.2 server', async () => {
    const server = await startTls({ maxVersion: 'TLSv1.2' });

    const error = await sendHttp(
      req({ url: `${server.url}/headers`, tls: { ca: [ca.certPem], minVersion: 'TLSv1.3' } }),
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).code).toBe('tls');
  });
});
