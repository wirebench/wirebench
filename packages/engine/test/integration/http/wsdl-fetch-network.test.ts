/**
 * A WSDL import with the host's `network`: every http(s) document goes through the proxy and CA
 * bundle the host resolved for it, whether the read is anonymous, Basic or Kerberos, as a definition
 * fetch for OpenAPI does (`document-fetch.test.ts`).
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { configureKerberos } from '#core/http/auth/kerberos-native';
import { importWsdl } from '#protocol-soap/soap/import';
import { fakeKerberos } from '../../helpers/fake-kerberos.js';
import { readPublicFixture } from '../../helpers/fixtures.js';
import { generateServerCert, generateTestCa, type TestCertificate } from '../../helpers/test-certs.js';
import { startTestProxy, type TestProxy } from '../../helpers/test-proxy.js';
import {
  startTestRestServer,
  type TestRestServer,
  type TestRestServerDocument,
  type TestRestServerOptions,
} from '../../helpers/test-rest-server.js';

const WSDL = readPublicFixture('calculator');
const TOKEN = Buffer.from('ap-req').toString('base64');

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  configureKerberos(undefined);
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function start(
  documents: Record<string, TestRestServerDocument>,
  options: Omit<TestRestServerOptions, 'documents'> = {},
): Promise<TestRestServer> {
  const server = await startTestRestServer({ ...options, documents });
  closers.push(() => server.close());
  return server;
}

async function proxy(): Promise<TestProxy> {
  const started = await startTestProxy();
  closers.push(() => started.close());
  return started;
}

/** The `network` a host passes: always `through`, recording every URL it was asked about. */
function networkThrough(through: TestProxy): {
  readonly asked: string[];
  readonly network: (url: string) => Promise<{ readonly proxy: { readonly url: string } }>;
} {
  const asked: string[] = [];
  return {
    asked,
    network: (url) => {
      asked.push(url);
      return Promise.resolve({ proxy: { url: through.url } });
    },
  };
}

describe('importWsdl with the host network', () => {
  it('reads the WSDL through the proxy the host resolved for its URL', async () => {
    const server = await start({ '/service.wsdl': { body: WSDL } });
    const through = await proxy();
    const url = `${server.url}/service.wsdl`;
    const { asked, network } = networkThrough(through);

    const result = await importWsdl({ kind: 'url', url }, { network });

    expect(result.bundle.root.location).toBe(url);
    expect(asked).toEqual([url]);
    expect(through.requests.map((request) => request.target)).toEqual([url]);
  });

  it('sends Basic credentials through the proxy too', async () => {
    const server = await start({ '/service.wsdl': { body: WSDL, auth: 'basic' } });
    const through = await proxy();
    const url = `${server.url}/service.wsdl`;
    const { network } = networkThrough(through);

    const result = await importWsdl({ kind: 'url', url }, { network, auth: { username: 'u', password: 'p' } });

    expect(result.operations.length).toBeGreaterThan(0);
    expect(through.requests.map((request) => request.target)).toEqual([url]);
    expect(server.requests.at(-1)?.headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('sends a Kerberos token through the proxy too', async () => {
    configureKerberos(fakeKerberos());
    const seen: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      seen.push(request.headers.authorization);
      if (request.headers.authorization !== `Negotiate ${TOKEN}`) {
        response.writeHead(401, { 'WWW-Authenticate': 'Negotiate' }).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/xml' }).end(WSDL);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/service.wsdl`;
    const through = await proxy();
    const { network } = networkThrough(through);

    const result = await importWsdl({ kind: 'url', url }, { network, auth: { type: 'kerberos' } });

    expect(result.operations.length).toBeGreaterThan(0);
    expect(seen).toEqual([`Negotiate ${TOKEN}`]);
    expect(through.requests.map((request) => request.target)).toEqual([url]);
  });

  describe('over TLS', () => {
    let ca: TestCertificate;
    let cert: TestCertificate;

    beforeAll(() => {
      ca = generateTestCa();
      cert = generateServerCert(ca);
    });

    it('trusts a WSDL server signed by the CA bundle the host resolved', async () => {
      const server = await start(
        { '/service.wsdl': { body: WSDL } },
        { tls: { cert: cert.certPem, key: cert.keyPem } },
      );
      const url = `${server.url}/service.wsdl`;

      const result = await importWsdl(
        { kind: 'url', url },
        { network: () => Promise.resolve({ tls: { ca: [ca.certPem] } }) },
      );

      expect(result.bundle.root.location).toBe(url);
    });

    it('refuses the same server when the host resolved no CA bundle', async () => {
      const server = await start(
        { '/service.wsdl': { body: WSDL } },
        { tls: { cert: cert.certPem, key: cert.keyPem } },
      );

      await expect(
        importWsdl({ kind: 'url', url: `${server.url}/service.wsdl` }, { network: () => Promise.resolve({}) }),
      ).rejects.toMatchObject({ code: 'fetch-failed', cause: { code: 'tls-untrusted' } });
    });
  });
});
