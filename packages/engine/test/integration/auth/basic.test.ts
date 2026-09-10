import { createServer, type Server } from 'node:http';
import { Agent, type Dispatcher } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError } from '../../../src/errors.js';
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

  // Task 34 rejected NTLM with `auth-unsupported`; Task 35 implements it, so what this
  // asserts now is that NTLM no longer throws and reports itself as the NTLM scheme.
  it('runs NTLM instead of rejecting it, short-circuiting when the server never challenges', async () => {
    server = await startTestSoapServer();
    const exchange = await send('/soap', { auth: { type: 'ntlm', username: 'user', password: 'pass' } });
    expect(exchange.http.status).toBe(200);
    expect(exchange.auth).toEqual({ scheme: 'ntlm', challenged: false, attempts: 1 });
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
    // A wrapping dispatcher records the headers/body timeout each attempt actually asked for,
    // so the retry's budget (not just that a retry happened) is verified.
    const dispatcher = new Agent();
    const timeouts: (number | null | undefined)[] = [];
    const originalDispatch = dispatcher.dispatch.bind(dispatcher);
    dispatcher.dispatch = (opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) => {
      timeouts.push(opts.headersTimeout);
      return originalDispatch(opts, handler);
    };

    const exchange = await sendSoapRequest(
      {
        endpoint: `${server.url}/auth/basic`,
        envelopeXml: ENVELOPE,
        soapVersion: '1.1',
        timeoutMs: 60_000,
        auth: { type: 'basic', username: 'user', password: 'pass', preemptive: false },
      },
      { now: clock, dispatcher },
    );
    await dispatcher.close();

    expect(exchange.http.status).toBe(200);
    expect(exchange.auth?.attempts).toBe(2);
    // First attempt gets the full budget; the retry gets what's left after the 40s the 401 took.
    expect(timeouts).toEqual([60_000, 20_000]);
  });

  it('sums both attempts into durationMs for a challenged send', async () => {
    // The delay sits entirely on the *first* (401) attempt; the retry answers immediately. A
    // `durationMs` that only reported the final attempt (the pre-fix behaviour) would come back
    // near-instant and miss it — summing both is what proves the delay was accounted for.
    const DELAY_MS = 150;
    let seen = 0;
    const slow: Server = createServer((req, res) => {
      seen += 1;
      if (seen === 1) {
        setTimeout(() => {
          res.writeHead(401, { 'www-authenticate': 'Basic realm="wirebench"', 'content-type': 'text/plain' });
          res.end('Unauthorized');
        }, DELAY_MS);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body/></soapenv:Envelope>',
      );
      void req;
    });
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const address = slow.address();
    if (address === null || typeof address === 'string') throw new Error('failed to bind');

    try {
      const exchange = await sendSoapRequest({
        endpoint: `http://127.0.0.1:${address.port}/auth/basic`,
        envelopeXml: ENVELOPE,
        soapVersion: '1.1',
        auth: { type: 'basic', username: 'user', password: 'pass', preemptive: false },
      });

      expect(exchange.auth).toEqual({ scheme: 'basic', challenged: true, attempts: 2 });
      expect(exchange.durationMs).toBeGreaterThanOrEqual(DELAY_MS);
    } finally {
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  });

  it('reports the 401 challenge without a doomed retry once the timeout budget is exhausted', async () => {
    server = await startTestSoapServer();
    let call = 0;
    const clock = (): number => {
      call += 1;
      // The budget is fully spent by the time the challenge comes back.
      return call === 1 ? 0 : 60_000;
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

    expect(exchange.http.status).toBe(401);
    expect(exchange.auth).toEqual({ scheme: 'basic', challenged: true, attempts: 1 });
    expect(server.requests).toHaveLength(1);
  });

  it('leaves an unauthenticated send untouched', async () => {
    server = await startTestSoapServer();
    const exchange = await send('/auth/basic', {});
    expect(exchange.http.status).toBe(401);
    expect(exchange.auth).toBeUndefined();
    expect(HttpError).toBeDefined();
  });
});
