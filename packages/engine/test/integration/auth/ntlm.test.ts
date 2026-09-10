import { afterEach, describe, expect, it } from 'vitest';
import { HttpError } from '../../../src/errors.js';
import { sendSoapRequest } from '../../../src/send.js';
import type { SendAuth } from '../../../src/types.js';
import { startNtlmServer, type NtlmServer } from '../../helpers/ntlm-server.js';
import { startTestSoapServer, type TestSoapServer } from '../../helpers/test-soap-server.js';

const ENVELOPE = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><Ping/></soapenv:Body></soapenv:Envelope>`;

const CREDENTIALS: SendAuth = {
  type: 'ntlm',
  username: 'user',
  password: 'pass',
  domain: 'WORKGROUP',
  workstation: 'WIRETEST',
};

let ntlm: NtlmServer | undefined;
let soap: TestSoapServer | undefined;

afterEach(async () => {
  await ntlm?.close();
  await soap?.close();
  ntlm = undefined;
  soap = undefined;
});

function send(url: string, auth: SendAuth, extra?: { signal?: AbortSignal; timeoutMs?: number }) {
  return sendSoapRequest({
    endpoint: url,
    envelopeXml: ENVELOPE,
    soapVersion: '1.1',
    soapAction: 'Ping',
    auth,
    timeoutMs: extra?.timeoutMs ?? 10_000,
    ...(extra?.signal !== undefined ? { signal: extra.signal } : {}),
  });
}

describe('NTLM handshake over HTTP', () => {
  it('authenticates in three legs over one connection, carrying the body on legs 1 and 3', async () => {
    ntlm = await startNtlmServer({ username: 'user', password: 'pass', domain: 'WORKGROUP' });

    const exchange = await send(ntlm.url, CREDENTIALS);

    expect(exchange.http.status).toBe(200);
    expect(exchange.auth).toEqual({ scheme: 'ntlm', challenged: true, attempts: 3 });
    expect(exchange.http.headers['x-auth-scheme']).toBe('ntlm');
    expect(exchange.response?.envelopeXml).toContain('<Ping/>');

    expect(ntlm.requests.map((entry) => entry.leg)).toEqual([1, 2, 3]);
    expect(ntlm.sameSocket()).toBe(true);
    // Leg 1 is the real request (the common case never challenges, so it must carry the
    // envelope); leg 2 (the Type 1 token) is bodyless; leg 3 (Type 3) carries the envelope
    // again, since it was discarded once the server challenged leg 1.
    expect(ntlm.requests.map((entry) => entry.contentLength > 0)).toEqual([true, false, true]);
    expect(ntlm.requests[1]?.authorization).toMatch(/^NTLM TlRMTVNTUAABAAAA/);
    expect(ntlm.requests[2]?.authorization).toMatch(/^NTLM TlRMTVNTUAADAAAA/);
  });

  it('sends leg 1 with the full body, leg 2 with Content-Length: 0, and leg 3 with the full body', async () => {
    ntlm = await startNtlmServer({ username: 'user', password: 'pass', domain: 'WORKGROUP' });

    await send(ntlm.url, CREDENTIALS);

    expect(ntlm.requests).toHaveLength(3);
    const envelopeLength = Buffer.byteLength(ENVELOPE, 'utf-8');
    expect(ntlm.requests[0]?.contentLength).toBe(envelopeLength);
    expect(ntlm.requests[1]?.contentLength).toBe(0);
    expect(ntlm.requests[2]?.contentLength).toBe(envelopeLength);
  });

  it('sums every leg into durationMs and reports the final leg as the exchange', async () => {
    ntlm = await startNtlmServer({ username: 'user', password: 'pass', domain: 'WORKGROUP' });

    const exchange = await send(ntlm.url, CREDENTIALS);

    expect(exchange.durationMs).toBeGreaterThanOrEqual(exchange.http.timings.totalMs);
    // The raw capture is the final leg: it carries the Type 3 token and the real body.
    const rawRequest = Buffer.from(exchange.http.rawRequest).toString('utf-8');
    expect(rawRequest).toContain('Authorization: NTLM TlRMTVNTUAADAAAA');
    expect(rawRequest).toContain('<Ping/>');
  });

  it('strips content-encoding/content-length from the bodyless leg 2 when the body is gzipped', async () => {
    ntlm = await startNtlmServer({ username: 'user', password: 'pass', domain: 'WORKGROUP' });

    await sendSoapRequest({
      endpoint: ntlm.url,
      envelopeXml: ENVELOPE,
      soapVersion: '1.1',
      soapAction: 'Ping',
      auth: CREDENTIALS,
      compressBody: 'gzip',
      timeoutMs: 10_000,
    });

    expect(ntlm.requests).toHaveLength(3);
    expect(ntlm.requests[0]?.contentEncoding).toBe('gzip');
    expect(ntlm.requests[1]?.contentEncoding).toBeUndefined();
    expect(ntlm.requests[2]?.contentEncoding).toBe('gzip');
  });

  it('returns the server 401 as a normal exchange when the password is wrong', async () => {
    ntlm = await startNtlmServer({ username: 'user', password: 'pass', domain: 'WORKGROUP' });

    const exchange = await send(ntlm.url, { ...CREDENTIALS, password: 'wrong' });

    expect(exchange.http.status).toBe(401);
    expect(exchange.auth).toEqual({ scheme: 'ntlm', challenged: true, attempts: 3 });
    expect(ntlm.requests.map((entry) => entry.leg)).toEqual([1, 2, 3]);
  });

  it('short-circuits after one attempt when the server never challenges', async () => {
    ntlm = await startNtlmServer({ username: 'user', password: 'pass', noAuthRequired: true });

    const exchange = await send(ntlm.url, CREDENTIALS);

    expect(exchange.http.status).toBe(200);
    expect(exchange.auth).toEqual({ scheme: 'ntlm', challenged: false, attempts: 1 });
    expect(ntlm.requests).toHaveLength(1);
  });

  it('accepts an NTLMSSP challenge advertised as Negotiate and answers as NTLM', async () => {
    ntlm = await startNtlmServer({
      username: 'user',
      password: 'pass',
      domain: 'WORKGROUP',
      advertiseNegotiate: true,
    });

    const exchange = await send(ntlm.url, CREDENTIALS);

    expect(exchange.http.status).toBe(200);
    expect(exchange.auth?.attempts).toBe(3);
    expect(ntlm.requests[2]?.authorization?.startsWith('NTLM ')).toBe(true);
  });

  it('works without a domain or workstation', async () => {
    ntlm = await startNtlmServer({ username: 'user', password: 'pass' });

    const exchange = await send(ntlm.url, { type: 'ntlm', username: 'user', password: 'pass' });

    expect(exchange.http.status).toBe(200);
    expect(exchange.auth?.attempts).toBe(3);
  });

  it('honours an abort raised while leg 2 is in flight', async () => {
    ntlm = await startNtlmServer({ username: 'user', password: 'pass', domain: 'WORKGROUP', delayLeg2Ms: 5_000 });
    const controller = new AbortController();
    const promise = send(ntlm.url, CREDENTIALS, { signal: controller.signal });
    // Abort once the Type 1 leg is on the wire and the (delayed) challenge is pending.
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(HttpError);
    await expect(promise).rejects.toMatchObject({ code: 'aborted' });
    expect(ntlm.requests.map((entry) => entry.leg)).toEqual([1, 2]);
  });

  it('shares one timeout budget across the legs', async () => {
    ntlm = await startNtlmServer({ username: 'user', password: 'pass', domain: 'WORKGROUP', delayLeg2Ms: 5_000 });

    await expect(send(ntlm.url, CREDENTIALS, { timeoutMs: 400 })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('authenticates against the shared test server’s /auth/ntlm route', async () => {
    soap = await startTestSoapServer();

    const exchange = await send(`${soap.url}/auth/ntlm`, CREDENTIALS);

    expect(exchange.http.status).toBe(200);
    expect(exchange.http.headers['x-auth-scheme']).toBe('ntlm');
    expect(exchange.auth).toEqual({ scheme: 'ntlm', challenged: true, attempts: 3 });
    expect(exchange.response?.envelopeXml).toContain('<Ping/>');
  });

  it('rejects a wrong password on /auth/ntlm with a 401', async () => {
    soap = await startTestSoapServer();

    const exchange = await send(`${soap.url}/auth/ntlm`, { ...CREDENTIALS, password: 'nope' });

    expect(exchange.http.status).toBe(401);
  });

  it('lets a caller-supplied Authorization header win over the handshake', async () => {
    ntlm = await startNtlmServer({ username: 'user', password: 'pass', noAuthRequired: true });

    const exchange = await sendSoapRequest({
      endpoint: ntlm.url,
      envelopeXml: ENVELOPE,
      soapVersion: '1.1',
      headers: { Authorization: 'NTLM caller-supplied' },
      auth: CREDENTIALS,
      timeoutMs: 10_000,
    });

    expect(exchange.auth).toEqual({ scheme: 'ntlm', challenged: false, attempts: 1 });
    expect(ntlm.requests).toHaveLength(1);
    expect(ntlm.requests[0]?.authorization).toBe('NTLM caller-supplied');
    // The single request carried the real body, since no handshake reserved it for a later leg.
    expect(ntlm.requests[0]?.contentLength).toBeGreaterThan(0);
  });

  it('never leaks the password into the request bytes', async () => {
    ntlm = await startNtlmServer({ username: 'user', password: 'sup3rsecret', domain: 'WORKGROUP' });

    const exchange = await send(ntlm.url, { ...CREDENTIALS, password: 'sup3rsecret' });

    expect(exchange.http.status).toBe(200);
    const raw = Buffer.from(exchange.http.rawRequest).toString('latin1');
    expect(raw).not.toContain('sup3rsecret');
    expect(Buffer.from(raw, 'latin1').toString('utf16le')).not.toContain('sup3rsecret');
  });
});
