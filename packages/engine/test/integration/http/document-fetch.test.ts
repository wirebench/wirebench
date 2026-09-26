/**
 * The OpenAPI and AsyncAPI document fetcher, against the in-process REST server: each credential
 * kind reads a protected document; a missing or wrong one is `definition-auth-required`; credentials
 * never leave the document's own origin, by redirect or by `$ref`; a query key never shows in a
 * location or an error; and the host's proxy and CA bundle are used.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpError } from '../../../src/errors.js';
import { createHttpFetchDocument } from '../../../src/http/document-fetch.js';
import { parseOpenApi } from '../../../src/rest/openapi/import.js';
import type { SendAuth } from '../../../src/types.js';
import { generateServerCert, generateTestCa, type TestCertificate } from '../../helpers/test-certs.js';
import { startTestProxy, type TestProxy } from '../../helpers/test-proxy.js';
import {
  startTestRestServer,
  type TestRestServer,
  type TestRestServerDocument,
  type TestRestServerOptions,
} from '../../helpers/test-rest-server.js';

const BASIC: SendAuth = { type: 'basic', username: 'u', password: 'p', preemptive: true };
const BEARER: SendAuth = { type: 'bearer', token: 'good-token' };
const HEADER_KEY: SendAuth = { type: 'api-key', name: 'X-Api-Key', value: 'good-key', in: 'header' };
const QUERY_KEY: SendAuth = { type: 'api-key', name: 'api_key', value: 'good-key', in: 'query' };

const DOCUMENT = 'openapi: 3.0.3\n';

const servers: TestRestServer[] = [];
const proxies: TestProxy[] = [];
const raws: RawServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  await Promise.all(raws.splice(0).map((raw) => raw.close()));
});

/** A bare HTTP server answering every request with `answer`, recording what it received. */
interface RawServer {
  readonly url: string;
  readonly requests: { readonly url: string; readonly headers: IncomingHttpHeaders }[];
  close(): Promise<void>;
}

async function startRaw(answer: (request: IncomingMessage, response: ServerResponse) => void): Promise<RawServer> {
  const requests: RawServer['requests'] = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? '', headers: request.headers });
    answer(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const raw: RawServer = {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  raws.push(raw);
  return raw;
}

/**
 * A forward proxy that answers every request itself with {@link DOCUMENT} and records the request as
 * it arrived, headers included: so a test can reach any host name, and see what went with it.
 */
function startRecordingProxy(): Promise<RawServer> {
  return startRaw((_request, response) => {
    response.writeHead(200, { 'content-length': String(Buffer.byteLength(DOCUMENT)) });
    response.end(DOCUMENT);
  });
}

async function start(
  documents: Record<string, TestRestServerDocument> = {},
  options: Omit<TestRestServerOptions, 'documents'> = {},
): Promise<TestRestServer> {
  const server = await startTestRestServer({ ...options, documents });
  servers.push(server);
  return server;
}

/** What `run` threw, as an `HttpError`, or a failure when it did not throw one. */
async function thrown(run: () => Promise<unknown>): Promise<HttpError> {
  const error = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
}

/** The last request `server` recorded. */
function last(server: TestRestServer) {
  const request = server.requests.at(-1);
  if (request === undefined) throw new Error('the server recorded no request');
  return request;
}

describe('createHttpFetchDocument', () => {
  it.each([
    ['basic', 'basic', BASIC],
    ['bearer', 'bearer', BEARER],
    ['a header API key', 'api-key', HEADER_KEY],
    ['a query API key', 'api-key', QUERY_KEY],
  ] as const)('reads a document protected by %s', async (_label, kind, auth) => {
    const server = await start({ '/openapi.yaml': { body: DOCUMENT, auth: kind } });
    const url = `${server.url}/openapi.yaml`;

    const fetched = await createHttpFetchDocument({ auth, authOrigin: new URL(url).origin })(url);

    expect(fetched.text).toBe(DOCUMENT);
    // The key this fetcher added is not part of where the document lives.
    expect(fetched.location).toBe(url);
  });

  it('says a document needs authentication when none was sent', async () => {
    const server = await start({ '/openapi.yaml': { body: DOCUMENT, auth: 'basic' } });
    const url = `${server.url}/openapi.yaml`;

    const error = await thrown(() => createHttpFetchDocument()(url));

    expect(error.code).toBe('definition-auth-required');
    expect(error.message).toBe(`The definition at ${url} needs authentication (HTTP 401).`);
    expect(error.details).toEqual({ location: url, status: 401, authSent: false });
  });

  it('says the credentials were refused when wrong ones were sent', async () => {
    const server = await start({ '/openapi.yaml': { body: DOCUMENT, auth: 'api-key' } });
    const url = `${server.url}/openapi.yaml`;
    const wrong: SendAuth = { ...QUERY_KEY, value: 'bad-key' };

    const error = await thrown(() => createHttpFetchDocument({ auth: wrong, authOrigin: new URL(url).origin })(url));

    expect(error.code).toBe('definition-auth-required');
    expect(error.message).toBe(`The definition at ${url} refused the credentials given (HTTP 403).`);
    expect(error.details).toEqual({ location: url, status: 403, authSent: true });
    expect(error.message).not.toContain('bad-key');
  });

  it('keeps any other failure a fetch failure', async () => {
    const server = await start();
    const url = `${server.url}/status/404`;

    const error = await thrown(() => createHttpFetchDocument()(url));

    expect(error.code).toBe('fetch-failed');
    expect(error.details).toEqual({ location: url, status: 404 });
  });

  it.each([
    ['basic', BASIC],
    ['bearer', BEARER],
    ['a header API key', HEADER_KEY],
    ['a query API key', QUERY_KEY],
  ] as const)('drops %s at a redirect to another origin', async (_label, auth) => {
    const other = await start({ '/openapi.yaml': { body: DOCUMENT } });
    const server = await start({}, { redirectOrigins: [other.url] });
    const url = `${server.url}/redirect/302?to=${encodeURIComponent(`${other.url}/openapi.yaml`)}`;

    const fetched = await createHttpFetchDocument({ auth, authOrigin: server.url })(url);

    expect(fetched.location).toBe(`${other.url}/openapi.yaml`);
    const reached = last(other);
    expect(reached.headers.authorization).toBeUndefined();
    expect(reached.headers['x-api-key']).toBeUndefined();
    expect(reached.url).not.toContain('api_key');
  });

  it.each([
    ['basic', 'basic', BASIC],
    ['a query API key', 'api-key', QUERY_KEY],
  ] as const)('keeps %s across a redirect on the same origin', async (_label, kind, auth) => {
    const server = await start({ '/moved.yaml': { body: DOCUMENT, auth: kind } });
    const url = `${server.url}/redirect/301?to=/moved.yaml`;

    const fetched = await createHttpFetchDocument({ auth, authOrigin: server.url })(url);

    expect(fetched.text).toBe(DOCUMENT);
    expect(fetched.location).toBe(`${server.url}/moved.yaml`);
  });

  it.each([
    ['basic', 'basic', BASIC],
    ['bearer', 'bearer', BEARER],
    ['a header API key', 'api-key', HEADER_KEY],
    ['a query API key', 'api-key', QUERY_KEY],
  ] as const)('sends %s again when a redirect comes back to its origin', async (_label, kind, auth) => {
    // Each server may redirect to the other; the lists are read per request, so they can be filled in
    // once both servers know their URLs.
    const toHome: string[] = [];
    const toAway: string[] = [];
    const home = await start({ '/openapi.yaml': { body: DOCUMENT, auth: kind } }, { redirectOrigins: toAway });
    const away = await start({}, { redirectOrigins: toHome });
    toHome.push(home.url);
    toAway.push(away.url);
    const back = `${away.url}/redirect/302?to=${encodeURIComponent(`${home.url}/openapi.yaml`)}`;
    const url = `${home.url}/redirect/302?to=${encodeURIComponent(back)}`;

    const fetched = await createHttpFetchDocument({ auth, authOrigin: home.url })(url);

    expect(fetched.text).toBe(DOCUMENT);
    expect(fetched.location).toBe(`${home.url}/openapi.yaml`);
    const passing = last(away);
    expect(passing.headers.authorization).toBeUndefined();
    expect(passing.headers['x-api-key']).toBeUndefined();
    expect(passing.url).not.toContain('good-key');
    expect(home.requests.map((request) => request.url.split('?')[0])).toEqual(['/redirect/302', '/openapi.yaml']);
  });

  it('never carries a query key the server echoed into a redirect to another origin', async () => {
    const other = await start({ '/openapi.yaml': { body: DOCUMENT } });
    const server = await start({}, { redirectOrigins: [other.url] });
    const echoed = `${other.url}/openapi.yaml?api_key=good-key`;
    const url = `${server.url}/redirect/302?to=${encodeURIComponent(echoed)}`;

    const fetched = await createHttpFetchDocument({ auth: QUERY_KEY, authOrigin: server.url })(url);

    expect(last(server).url).toContain('api_key=good-key');
    expect(fetched.location).toBe(`${other.url}/openapi.yaml`);
    expect(last(other).url).toBe('/openapi.yaml');
  });

  it('never shows a query key in an error after a redirect to another origin', async () => {
    const other = await start();
    const server = await start({}, { redirectOrigins: [other.url] });
    const echoed = `${other.url}/status/404?api_key=good-key`;
    const url = `${server.url}/redirect/302?to=${encodeURIComponent(echoed)}`;

    const error = await thrown(() => createHttpFetchDocument({ auth: QUERY_KEY, authOrigin: server.url })(url));

    expect(error.code).toBe('fetch-failed');
    expect(error.details).toEqual({ location: `${other.url}/status/404`, status: 404 });
    expect(error.message).not.toContain('good-key');
  });

  it('never shows a query key in a refusal or a redirect-limit error', async () => {
    const server = await start({ '/openapi.yaml': { body: DOCUMENT, auth: 'api-key' } });
    const fetchDocument = createHttpFetchDocument({
      auth: { ...QUERY_KEY, value: 'wrong-key' },
      authOrigin: server.url,
    });

    const refused = await thrown(() => fetchDocument(`${server.url}/openapi.yaml`));
    expect(refused.code).toBe('definition-auth-required');
    expect(last(server).url).toContain('api_key=wrong-key');
    expect(`${refused.message} ${JSON.stringify(refused.details)}`).not.toContain('wrong-key');

    // Six hops, each back to the next, one more than the fetcher follows.
    let loop = `${server.url}/openapi.yaml`;
    for (let hop = 0; hop < 6; hop += 1) {
      loop = `${server.url}/redirect/302?to=${encodeURIComponent(loop.slice(server.url.length))}`;
    }
    const looped = await thrown(() => fetchDocument(`${loop}&api_key=wrong-key`));
    expect(looped.code).toBe('too-many-redirects');
    expect(`${looped.message} ${JSON.stringify(looped.details)}`).not.toContain('wrong-key');
  });

  it('sends credentials to a $ref sibling on the same origin, and not to one on another', async () => {
    const other = await start({ '/pet.yaml': { body: 'type: object\n' } });
    const documents: Record<string, TestRestServerDocument> = {};
    const server = await start(documents);
    documents['/common.yaml'] = { body: 'type: string\n', auth: 'basic' };
    documents['/openapi.yaml'] = {
      auth: 'basic',
      body: [
        'openapi: 3.0.3',
        'info: { title: Pets, version: "1" }',
        'paths: {}',
        'components:',
        '  schemas:',
        '    Name:',
        `      $ref: '${server.url}/common.yaml'`,
        '    Pet:',
        `      $ref: '${other.url}/pet.yaml'`,
        '',
      ].join('\n'),
    };
    const fetchDocument = createHttpFetchDocument({ auth: BASIC, authOrigin: server.url });

    const parsed = await parseOpenApi({ kind: 'url', url: `${server.url}/openapi.yaml` }, { fetchDocument });

    expect(parsed.refProblems).toEqual([]);
    expect(parsed.documents.map((document) => document.location).sort()).toEqual(
      [`${server.url}/openapi.yaml`, `${server.url}/common.yaml`, `${other.url}/pet.yaml`].sort(),
    );
    expect(last(other).headers.authorization).toBeUndefined();
  });

  it('never shows a query key in the location or in an error', async () => {
    const server = await start({ '/openapi.yaml': { body: DOCUMENT, auth: 'api-key' } });
    const origin = server.url;
    const fetchDocument = createHttpFetchDocument({ auth: QUERY_KEY, authOrigin: origin });

    const fetched = await fetchDocument(`${origin}/openapi.yaml`);
    expect(fetched.location).not.toContain('good-key');
    expect(last(server).url).toContain('api_key=good-key');

    const missing = await thrown(() => fetchDocument(`${origin}/status/500`));
    expect(missing.message).not.toContain('good-key');
    expect(JSON.stringify(missing.details)).not.toContain('good-key');

    await server.close();
    servers.splice(servers.indexOf(server), 1);
    const refused = await thrown(() => fetchDocument(`${origin}/openapi.yaml`));
    expect(refused.message).not.toContain('good-key');
    expect(JSON.stringify(refused.details)).not.toContain('good-key');
  });

  it.each([
    ['a trailing slash', 'http://docs.example.test/'],
    ['an uppercase host', 'http://DOCS.Example.TEST'],
    ['an explicit default port', 'http://docs.example.test:80'],
  ])('matches an auth origin written with %s', async (_label, authOrigin) => {
    const proxy = await startRecordingProxy();
    const url = 'http://docs.example.test/openapi.yaml';

    const fetched = await createHttpFetchDocument({
      auth: BEARER,
      authOrigin,
      network: () => Promise.resolve({ proxy: { url: proxy.url } }),
    })(url);

    expect(fetched.text).toBe(DOCUMENT);
    expect(proxy.requests.map((request) => request.url)).toEqual([url]);
    expect(proxy.requests[0]?.headers.authorization).toBe('Bearer good-token');
  });

  it.each([['not a url'], ['null'], ['file:///etc'], ['data:text/plain,x'], ['ftp://docs.example.test']])(
    'refuses %s as an auth origin at once',
    (authOrigin) => {
      let error: unknown;
      try {
        createHttpFetchDocument({ auth: BASIC, authOrigin });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).code).toBe('invalid-url');
    },
  );

  it('refuses a redirect off http(s), without asking the host about it', async () => {
    const server = await startRaw((_request, response) => {
      response.writeHead(302, { location: 'file:///etc/passwd', 'content-length': '0' });
      response.end();
    });
    const url = `${server.url}/openapi.yaml`;
    const asked: string[] = [];

    const error = await thrown(() =>
      createHttpFetchDocument({
        auth: BASIC,
        authOrigin: server.url,
        network: (target) => {
          asked.push(target);
          return Promise.resolve({});
        },
      })(url),
    );

    expect(error.code).toBe('fetch-failed');
    expect(error.message).toContain('file:');
    expect(error.details).toEqual({ location: url, status: 302 });
    expect(asked).toEqual([url]);
  });

  it.each([
    ['bearer', BEARER, 'good-token'],
    ['a header API key', HEADER_KEY, 'good-key'],
    ['basic', BASIC, Buffer.from('u:p').toString('base64')],
    ['a query API key', QUERY_KEY, 'good-key'],
  ] as const)('keeps %s out of a transport failure', async (_label, auth, secret) => {
    const server = await start();
    const origin = server.url;
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    const url = `${origin}/openapi.yaml`;

    const error = await thrown(() => createHttpFetchDocument({ auth, authOrigin: origin })(url));

    expect(error.code).toBe('connection-refused');
    expect(error.details).not.toHaveProperty('request');
    // What the transport said is kept; only the request as sent goes.
    expect(error.details).toEqual({ code: 'ECONNREFUSED', location: url });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error.message).not.toContain(secret);
  });

  it('follows exactly five redirects', async () => {
    const server = await start({ '/openapi.yaml': { body: DOCUMENT, auth: 'basic' } });
    let path = '/openapi.yaml';
    for (let hop = 0; hop < 5; hop += 1) {
      path = `/redirect/302?to=${encodeURIComponent(path)}`;
    }

    const fetched = await createHttpFetchDocument({ auth: BASIC, authOrigin: server.url })(`${server.url}${path}`);

    expect(fetched.text).toBe(DOCUMENT);
    expect(fetched.location).toBe(`${server.url}/openapi.yaml`);
    expect(server.requests).toHaveLength(6);
  });

  it('reads a file: location as the default fetcher does', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wirebench-document-fetch-'));
    const path = join(dir, 'openapi.yaml');
    await writeFile(path, DOCUMENT);

    const fetched = await createHttpFetchDocument({ auth: BASIC, authOrigin: 'http://127.0.0.1' })(
      pathToFileURL(path).href,
    );

    expect(fetched.text).toBe(DOCUMENT);
    await rm(dir, { recursive: true, force: true });
  });

  it('goes through the proxy the host resolved for the URL', async () => {
    const server = await start({ '/openapi.yaml': { body: DOCUMENT } });
    const proxy = await startTestProxy();
    proxies.push(proxy);
    const url = `${server.url}/openapi.yaml`;
    const asked: string[] = [];

    await createHttpFetchDocument({
      network: (target) => {
        asked.push(target);
        return Promise.resolve({ proxy: { url: proxy.url } });
      },
    })(url);

    expect(asked).toEqual([url]);
    expect(proxy.requests.map((request) => request.target)).toEqual([url]);
  });

  describe('over TLS', () => {
    let ca: TestCertificate;
    let cert: TestCertificate;

    beforeAll(() => {
      ca = generateTestCa();
      cert = generateServerCert(ca);
    });

    it('trusts a server signed by the CA bundle the host resolved, and nothing else', async () => {
      const server = await start(
        { '/openapi.yaml': { body: DOCUMENT } },
        { tls: { cert: cert.certPem, key: cert.keyPem } },
      );
      const url = `${server.url}/openapi.yaml`;

      const untrusted = await thrown(() => createHttpFetchDocument()(url));
      expect(untrusted.code).toBe('tls-untrusted');

      const fetched = await createHttpFetchDocument({ network: () => Promise.resolve({ tls: { ca: [ca.certPem] } }) })(
        url,
      );
      expect(fetched.text).toBe(DOCUMENT);
    });

    it('sends nothing to the same host and port once a redirect drops to plain http', async () => {
      const plain: string[] = [];
      const server = await start({}, { tls: { cert: cert.certPem, key: cert.keyPem }, redirectOrigins: plain });
      const downgraded = `${server.url.replace(/^https:/, 'http:')}/openapi.yaml`;
      plain.push(new URL(downgraded).origin);
      // The plain-http hop goes to a recording proxy: the TLS server on that port cannot read it.
      const proxy = await startRecordingProxy();
      const url = `${server.url}/redirect/302?to=${encodeURIComponent(downgraded)}`;

      const fetched = await createHttpFetchDocument({
        auth: BASIC,
        authOrigin: server.url,
        network: (target) =>
          Promise.resolve(target.startsWith('https:') ? { tls: { ca: [ca.certPem] } } : { proxy: { url: proxy.url } }),
      })(url);

      expect(fetched.location).toBe(downgraded);
      expect(last(server).headers.authorization).toBeDefined();
      expect(proxy.requests.map((request) => request.url)).toEqual([downgraded]);
      expect(proxy.requests[0]?.headers.authorization).toBeUndefined();
    });
  });
});
