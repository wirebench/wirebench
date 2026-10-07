import { afterEach, describe, expect, it } from 'vitest';
import { sendWithAuth } from '../../../src/http/auth/apply.js';
import { configureKerberos } from '../../../src/http/auth/kerberos-native.js';
import { fakeKerberos } from '../../helpers/fake-kerberos.js';
import { startNegotiateServer, type NegotiateServer } from '../../helpers/negotiate-server.js';
import { startRedirectServer, type RedirectServer } from '../../helpers/redirect-server.js';

const TOKEN = Buffer.from('ap-req').toString('base64');
const REPLY = Buffer.from('ap-rep').toString('base64');
let server: NegotiateServer | undefined;
let redirector: RedirectServer | undefined;

afterEach(async () => {
  configureKerberos(undefined);
  await server?.close();
  await redirector?.close();
  server = undefined;
  redirector = undefined;
});

const post = (url: string, timeoutMs = 10_000) => ({
  url,
  method: 'POST' as const,
  headers: { 'content-type': 'text/xml' },
  body: Buffer.from('<Envelope/>'),
  timeoutMs,
  followRedirects: false,
});

describe('Kerberos over HTTP Negotiate', () => {
  it('answers a challenge on the same connection, the body sent twice, and verifies the reply', async () => {
    const provider = fakeKerberos();
    configureKerberos(provider);
    server = await startNegotiateServer({ expectedToken: TOKEN, reply: REPLY });
    const result = await sendWithAuth(post(server.url), { type: 'kerberos' });
    expect(result.http.status).toBe(200);
    expect(result.auth).toEqual({
      scheme: 'kerberos',
      challenged: true,
      attempts: 2,
      spn: process.platform === 'win32' ? 'HTTP/127.0.0.1' : 'HTTP@127.0.0.1',
    });
    expect(server.requests.map((entry) => entry.body)).toEqual(['<Envelope/>', '<Envelope/>']);
    expect(server.sameSocket()).toBe(true);
    expect(provider.steps).toEqual(['', REPLY]);
  });

  it('never touches the provider when the server does not ask for Negotiate', async () => {
    const provider = fakeKerberos();
    configureKerberos(provider);
    server = await startNegotiateServer({ expectedToken: TOKEN, challenge: 'Basic realm="x"' });
    const result = await sendWithAuth(post(server.url), { type: 'kerberos' });
    expect(result.http.status).toBe(401);
    expect(result.auth).toMatchObject({ scheme: 'kerberos', challenged: true, attempts: 1 });
    expect(provider.inits).toEqual([]);
  });

  it('fails a second 401 as kerberos-rejected', async () => {
    configureKerberos(fakeKerberos());
    server = await startNegotiateServer({ expectedToken: TOKEN, rejectToken: true });
    await expect(sendWithAuth(post(server.url), { type: 'kerberos' })).rejects.toMatchObject({
      code: 'kerberos-rejected',
    });
  });

  it('fails a reply that does not verify as kerberos-mutual-auth-failed', async () => {
    configureKerberos(fakeKerberos({ verifyFails: true }));
    server = await startNegotiateServer({ expectedToken: TOKEN, reply: REPLY });
    await expect(sendWithAuth(post(server.url), { type: 'kerberos' })).rejects.toMatchObject({
      code: 'kerberos-mutual-auth-failed',
    });
  });

  it('takes a blank SPN as the default one', async () => {
    const provider = fakeKerberos();
    configureKerberos(provider);
    server = await startNegotiateServer({ expectedToken: TOKEN, reply: REPLY });
    const result = await sendWithAuth(post(server.url), { type: 'kerberos', spn: '' });
    expect(result.http.status).toBe(200);
    expect(provider.inits.map((init) => init.spn)).toEqual([
      process.platform === 'win32' ? 'HTTP/127.0.0.1' : 'HTTP@127.0.0.1',
    ]);
  });

  it('lets a caller-supplied Authorization header win', async () => {
    const provider = fakeKerberos();
    configureKerberos(provider);
    server = await startNegotiateServer({ expectedToken: TOKEN });
    const result = await sendWithAuth(
      { ...post(server.url), headers: { authorization: `Negotiate ${TOKEN}` } },
      { type: 'kerberos' },
    );
    expect(result.http.status).toBe(200);
    expect(provider.inits).toEqual([]);
  });

  it('reports the 401 when the time budget is spent before leg 2', async () => {
    const provider = fakeKerberos();
    configureKerberos(provider);
    server = await startNegotiateServer({ expectedToken: TOKEN });
    let clock = 0;
    const result = await sendWithAuth(post(server.url, 1000), { type: 'kerberos' }, { now: () => (clock += 600) });
    expect(result.http.status).toBe(401);
    expect(result.auth).toMatchObject({ challenged: true, attempts: 1 });
    expect(provider.inits).toEqual([]);
    expect(server.requests).toHaveLength(1);
  });

  it('reports the 401 when making the token spends the time budget', async () => {
    const provider = fakeKerberos();
    let clock = 0;
    configureKerberos({
      ...provider,
      initClient: async (input) => {
        const client = await provider.initClient(input);
        clock += 2000;
        return client;
      },
    });
    server = await startNegotiateServer({ expectedToken: TOKEN });
    const result = await sendWithAuth(post(server.url, 1000), { type: 'kerberos' }, { now: () => clock });
    expect(result.http.status).toBe(401);
    expect(result.auth).toMatchObject({ challenged: true, attempts: 1 });
    expect(provider.inits).toHaveLength(1);
    expect(server.requests).toHaveLength(1);
  });

  it('fails a hung token wait with timeout within the send budget, after leg 1 only (#267)', async () => {
    const provider = fakeKerberos({ hang: 'init' });
    configureKerberos(provider);
    server = await startNegotiateServer({ expectedToken: TOKEN, reply: REPLY });
    const started = Date.now();
    await expect(sendWithAuth(post(server.url, 300), { type: 'kerberos' })).rejects.toMatchObject({
      code: 'timeout',
      details: { stage: 'kerberos' },
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(server.requests).toHaveLength(1);
    provider.release();
  });

  it('returns at once with aborted when cancelled during the token wait (#267)', async () => {
    const provider = fakeKerberos({ hang: 'init' });
    configureKerberos(provider);
    server = await startNegotiateServer({ expectedToken: TOKEN, reply: REPLY });
    const controller = new AbortController();
    const pending = sendWithAuth({ ...post(server.url), signal: controller.signal }, { type: 'kerberos' });
    // `inits` grows once the server's 401 has arrived and the token wait has started.
    while (provider.inits.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const abortedAt = Date.now();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(Date.now() - abortedAt).toBeLessThan(1000);
    provider.release();
  });

  describe('after a redirect (#266)', () => {
    const SPN = process.platform === 'win32' ? 'HTTP/127.0.0.1' : 'HTTP@127.0.0.1';
    const follow = (url: string) => ({ ...post(url), followRedirects: true });

    it('sends leg 2 straight to the hop that challenged, with that hop’s SPN', async () => {
      const provider = fakeKerberos();
      configureKerberos(provider);
      server = await startNegotiateServer({
        expectedToken: TOKEN,
        reply: REPLY,
        redirect: { from: '/old', status: 307 },
      });
      const result = await sendWithAuth(follow(server.url.replace('/svc', '/old')), { type: 'kerberos' });
      expect(result.http.status).toBe(200);
      expect(result.http.request.url).toBe(server.url);
      expect(result.http.redirects).toEqual([{ url: server.url.replace('/svc', '/old'), status: 307 }]);
      expect(result.auth).toEqual({ scheme: 'kerberos', challenged: true, attempts: 2, spn: SPN });
      expect(provider.inits.map((init) => init.spn)).toEqual([SPN]);
      expect(server.redirected).toHaveLength(1);
      expect(server.requests.map((entry) => [entry.path, entry.authorization, entry.body])).toEqual([
        ['/svc', undefined, '<Envelope/>'],
        ['/svc', `Negotiate ${TOKEN}`, '<Envelope/>'],
      ]);
      expect(server.sameSocket()).toBe(true);
    });

    it('repeats the hop’s method too: a 302 turned the POST into a bodyless GET', async () => {
      configureKerberos(fakeKerberos());
      server = await startNegotiateServer({ expectedToken: TOKEN, redirect: { from: '/old', status: 302 } });
      const result = await sendWithAuth(follow(server.url.replace('/svc', '/old')), { type: 'kerberos' });
      expect(result.http.status).toBe(200);
      expect(server.requests.map((entry) => [entry.method, entry.authorization, entry.body])).toEqual([
        ['GET', undefined, ''],
        ['GET', `Negotiate ${TOKEN}`, ''],
      ]);
    });

    it('names the hop that challenged when it refuses the token', async () => {
      configureKerberos(fakeKerberos());
      server = await startNegotiateServer({
        expectedToken: TOKEN,
        rejectToken: true,
        redirect: { from: '/old', status: 307 },
      });
      const sent = sendWithAuth(follow(server.url.replace('/svc', '/old')), { type: 'kerberos' });
      await expect(sent).rejects.toMatchObject({ code: 'kerberos-rejected', details: { url: server.url } });
      await expect(sent).rejects.toThrow(server.url);
    });

    it('makes no token for a hop on another origin, and names that hop', async () => {
      const provider = fakeKerberos();
      configureKerberos(provider);
      server = await startNegotiateServer({ expectedToken: TOKEN });
      const target = server.url;
      redirector = await startRedirectServer(() => target);
      const sent = sendWithAuth(follow(redirector.url), { type: 'kerberos' });
      await expect(sent).rejects.toMatchObject({ code: 'kerberos-cross-origin', details: { url: target } });
      await expect(sent).rejects.toThrow(target);
      expect(provider.inits).toEqual([]);
      expect(server.requests.map((entry) => entry.authorization)).toEqual([undefined]);
      expect(redirector.authorizations).toEqual([undefined]);
    });
  });
});
