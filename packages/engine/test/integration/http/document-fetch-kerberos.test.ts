import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { configureKerberos } from '../../../src/http/auth/kerberos-native.js';
import { createHttpFetchDocument } from '../../../src/http/document-fetch.js';
import { importWsdl } from '../../../src/soap/import.js';
import { fakeKerberos } from '../../helpers/fake-kerberos.js';

const TOKEN = Buffer.from('ap-req').toString('base64');
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  configureKerberos(undefined);
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** Serves `body` only to `Negotiate <TOKEN>`; with `redirectTo`, redirects every request there first. */
async function serve(body: string, redirectTo?: () => string): Promise<{ url: string; seen: (string | undefined)[] }> {
  const seen: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    seen.push(request.headers.authorization);
    if (redirectTo !== undefined) {
      response.writeHead(302, { Location: redirectTo() }).end();
      return;
    }
    if (request.headers.authorization !== `Negotiate ${TOKEN}`) {
      response.writeHead(401, { 'WWW-Authenticate': 'Negotiate' }).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/plain' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/doc`, seen };
}

describe('Kerberos on definition fetches', () => {
  it('attaches a preemptive Negotiate token on a same-origin hop', async () => {
    configureKerberos(fakeKerberos());
    const doc = await serve('openapi: 3.1.0');
    const fetch = createHttpFetchDocument({ auth: { type: 'kerberos' }, authOrigin: new URL(doc.url).origin });
    await expect(fetch(doc.url)).resolves.toMatchObject({ text: 'openapi: 3.1.0' });
    expect(doc.seen).toEqual([`Negotiate ${TOKEN}`]);
  });

  it('never sends it to another origin', async () => {
    configureKerberos(fakeKerberos());
    const other = await serve('x');
    const first = await serve('', () => other.url);
    const fetch = createHttpFetchDocument({ auth: { type: 'kerberos' }, authOrigin: new URL(first.url).origin });
    await expect(fetch(first.url)).rejects.toMatchObject({ code: 'definition-auth-required' });
    expect(other.seen).toEqual([undefined]);
  });

  it('surfaces an unavailable provider as kerberos-unavailable, not definition-auth-required', async () => {
    configureKerberos(fakeKerberos({ unavailable: 'no GSS library' }));
    const doc = await serve('openapi: 3.1.0');
    const fetch = createHttpFetchDocument({ auth: { type: 'kerberos' }, authOrigin: new URL(doc.url).origin });
    await expect(fetch(doc.url)).rejects.toMatchObject({ code: 'kerberos-unavailable' });
    expect(doc.seen).toEqual([]);
  });

  it('imports a WSDL with Kerberos through the origin-scoped fetcher', async () => {
    configureKerberos(fakeKerberos());
    const wsdl = await serve('<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" name="Empty"/>');
    await importWsdl({ kind: 'url', url: wsdl.url }, { auth: { type: 'kerberos' } });
    expect(wsdl.seen[0]).toBe(`Negotiate ${TOKEN}`);
  });
});
