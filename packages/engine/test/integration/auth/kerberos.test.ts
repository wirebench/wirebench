import { afterEach, describe, expect, it } from 'vitest';
import { sendWithAuth } from '../../../src/http/auth/apply.js';
import { configureKerberos } from '../../../src/http/auth/kerberos-native.js';
import { kerberosHandshake } from '../../../src/http/auth/kerberos-transport.js';
import { fakeKerberos } from '../../helpers/fake-kerberos.js';
import { startNegotiateServer, type NegotiateServer } from '../../helpers/negotiate-server.js';

const TOKEN = Buffer.from('ap-req').toString('base64');
const REPLY = Buffer.from('ap-rep').toString('base64');
let server: NegotiateServer | undefined;

afterEach(async () => {
  configureKerberos(undefined);
  await server?.close();
  server = undefined;
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

  it('sends preemptively when asked: one request', async () => {
    configureKerberos(fakeKerberos());
    server = await startNegotiateServer({ expectedToken: TOKEN });
    const result = await kerberosHandshake(post(server.url), { type: 'kerberos' }, { preemptive: true });
    expect(result.attempts).toBe(1);
    expect(result.http.status).toBe(200);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.authorization).toBe(`Negotiate ${TOKEN}`);
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
});
