import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError, WirebenchError } from '../../../src/errors.js';
import { sendSoapRequest } from '../../../src/send.js';
import { startTestSoapServer, type TestSoapServer } from '../../helpers/test-soap-server.js';

const ENVELOPE = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><ping/></soapenv:Body></soapenv:Envelope>`;

const AUTHORIZATION = `Basic ${Buffer.from('user:pass', 'utf-8').toString('base64')}`;

describe('send — HTTP Basic authentication', () => {
  let server: TestSoapServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const send = async (path: string, overrides: Record<string, unknown>) =>
    sendSoapRequest({
      endpoint: `${server!.url}${path}`,
      envelopeXml: ENVELOPE,
      soapVersion: '1.1',
      ...overrides,
    });

  it('passes on the first attempt when preemptive', async () => {
    server = await startTestSoapServer();
    const exchange = await send('/auth/basic', {
      auth: { type: 'basic', username: 'user', password: 'pass', preemptive: true },
    });

    expect(exchange.http.status).toBe(200);
    expect(exchange.http.headers['x-auth-scheme']).toBe('basic');
    expect(exchange.auth).toEqual({ scheme: 'basic', challenged: false, attempts: 1 });
    expect(server.requests).toHaveLength(1);
    expect(exchange.http.request.headers['Authorization']).toBe(AUTHORIZATION);
    // The raw capture is what the redaction layer masks; it must contain the header it sent.
    expect(Buffer.from(exchange.http.rawRequest).toString('utf-8')).toContain('Authorization: Basic ');
  });

  it('retries once with credentials after a 401 challenge', async () => {
    server = await startTestSoapServer();
    const exchange = await send('/auth/basic', {
      auth: { type: 'basic', username: 'user', password: 'pass', preemptive: false },
    });

    expect(exchange.http.status).toBe(200);
    expect(exchange.auth).toEqual({ scheme: 'basic', challenged: true, attempts: 2 });
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
    expect(server.requests[1]?.headers.authorization).toBe(AUTHORIZATION);
  });

  it('surfaces a final 401 as a normal exchange when the password is wrong', async () => {
    server = await startTestSoapServer();
    const exchange = await send('/auth/basic', {
      auth: { type: 'basic', username: 'user', password: 'wrong', preemptive: false },
    });

    expect(exchange.http.status).toBe(401);
    expect(exchange.auth).toEqual({ scheme: 'basic', challenged: true, attempts: 2 });
    expect(exchange.response?.isSoap).toBe(false);
  });

  it('does not retry a 401 that carries no challenge', async () => {
    server = await startTestSoapServer();
    const exchange = await send('/auth/basic-nochallenge', {
      auth: { type: 'basic', username: 'user', password: 'pass', preemptive: false },
    });

    expect(exchange.http.status).toBe(401);
    expect(exchange.auth).toEqual({ scheme: 'basic', challenged: false, attempts: 1 });
    expect(server.requests).toHaveLength(1);
  });

  it('lets a caller-supplied Authorization header win, with no second header or retry', async () => {
    server = await startTestSoapServer();
    const exchange = await send('/auth/basic', {
      headers: { Authorization: AUTHORIZATION },
      auth: { type: 'basic', username: 'other', password: 'nope', preemptive: true },
    });

    expect(exchange.http.status).toBe(200);
    expect(exchange.auth).toEqual({ scheme: 'basic', challenged: false, attempts: 1 });
    expect(server.requests[0]?.headers.authorization).toBe(AUTHORIZATION);
  });

  it('rejects NTLM with a reserved auth-unsupported code', async () => {
    server = await startTestSoapServer();
    await expect(send('/soap', { auth: { type: 'ntlm', username: 'user', password: 'pass' } })).rejects.toMatchObject({
      code: 'auth-unsupported',
    });
    await expect(send('/soap', { auth: { type: 'ntlm', username: 'u', password: 'p' } })).rejects.toBeInstanceOf(
      WirebenchError,
    );
  });

  it('honours an abort raised during the challenge retry', async () => {
    // A local server so the retry can be held open long enough to abort it deterministically.
    let seen = 0;
    const slow: Server = createServer((_req, res) => {
      seen += 1;
      if (seen === 1) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="wirebench"', 'content-type': 'text/plain' });
        res.end('Unauthorized');
        return;
      }
      controller.abort();
      // Never answers: the abort is what ends the retry.
    });
    const controller = new AbortController();
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const address = slow.address();
    if (address === null || typeof address === 'string') throw new Error('failed to bind');

    try {
      await expect(
        sendSoapRequest({
          endpoint: `http://127.0.0.1:${address.port}/auth/basic`,
          envelopeXml: ENVELOPE,
          soapVersion: '1.1',
          signal: controller.signal,
          auth: { type: 'basic', username: 'user', password: 'pass', preemptive: false },
        }),
      ).rejects.toMatchObject({ code: 'aborted' });
      expect(seen).toBe(2);
    } finally {
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  });

  it('shares one timeout budget across both attempts', async () => {
    server = await startTestSoapServer();
    let call = 0;
    const clock = (): number => {
      call += 1;
      // The first read is the send's start; the second (after the 401) is 40s later.
      return call === 1 ? 0 : 40_000;
    };
    const exchange = await sendSoapRequest(
      {
        endpoint: `${server.url}/auth/basic`,
        envelopeXml: ENVELOPE,
        soapVersion: '1.1',
        timeoutMs: 60_000,
        auth: { type: 'basic', username: 'user', password: 'pass', preemptive: false },
      },
      { now: clock },
    );

    expect(exchange.http.status).toBe(200);
    expect(exchange.auth?.attempts).toBe(2);
  });

  it('leaves an unauthenticated send untouched', async () => {
    server = await startTestSoapServer();
    const exchange = await send('/auth/basic', {});
    expect(exchange.http.status).toBe(401);
    expect(exchange.auth).toBeUndefined();
    expect(HttpError).toBeDefined();
  });
});
