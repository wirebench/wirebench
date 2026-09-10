// @vitest-environment node
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EngineService, toEngineAuth, withResolvedAuth } from '../src/main/engine-service.js';
import { REDACTED_MARKER } from '../src/main/redact.js';

const AUTHORIZATION = `Basic ${Buffer.from('user:pass', 'utf-8').toString('base64')}`;

/** A server that answers the first attempt with a 401 Basic challenge and echoes once authorised. */
async function startChallengeServer(): Promise<{ url: string; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? '');
    if (req.headers.authorization !== AUTHORIZATION) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="wirebench"', 'content-type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body/></soapenv:Envelope>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    seen,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe('toEngineAuth', () => {
  it('maps resolved basic credentials, defaulting preemptive to true', () => {
    expect(toEngineAuth({ type: 'basic', username: 'u', password: 'p' })).toEqual({
      type: 'basic',
      username: 'u',
      password: 'p',
      preemptive: true,
    });
    expect(toEngineAuth({ type: 'basic', username: 'u', password: 'p', preemptive: false })).toMatchObject({
      preemptive: false,
    });
  });

  it('maps NTLM credentials with their domain', () => {
    expect(toEngineAuth({ type: 'ntlm', username: 'u', password: 'p', domain: 'CORP' })).toEqual({
      type: 'ntlm',
      username: 'u',
      password: 'p',
      domain: 'CORP',
    });
  });

  it('is undefined without credentials, for type none, and for an incomplete pair', () => {
    expect(toEngineAuth(undefined)).toBeUndefined();
    expect(toEngineAuth({ type: 'none' })).toBeUndefined();
    expect(toEngineAuth({ type: 'basic', username: 'u' })).toBeUndefined();
  });
});

describe('withResolvedAuth (cURL export path)', () => {
  it('still bakes a preemptive header in, since an exported command has no challenge loop', () => {
    const input = { endpoint: 'http://x.test', envelopeXml: '<a/>', soapVersion: '1.1' as const };
    expect(withResolvedAuth(input, { type: 'basic', username: 'user', password: 'pass' }).headers).toEqual({
      Authorization: AUTHORIZATION,
    });
  });
});

describe('EngineService.send — Basic authentication', () => {
  let server: Awaited<ReturnType<typeof startChallengeServer>>;
  let service: EngineService;

  beforeEach(async () => {
    server = await startChallengeServer();
    service = new EngineService((ref) => Promise.resolve(ref === 'ref-1' ? 'pass' : undefined));
  });

  afterEach(async () => {
    await server.close();
  });

  it('retries the 401 challenge and reports the auth summary, with the header redacted', async () => {
    const exchange = await service.send(
      {
        sendId: 'send-auth-1',
        input: { endpoint: `${server.url}/soap`, envelopeXml: '<a/>', soapVersion: '1.1' },
      },
      { auth: { type: 'basic', username: 'user', passwordRef: 'ref-1', preemptive: false } },
    );

    expect(exchange.http.status).toBe(200);
    expect(exchange.auth).toEqual({ scheme: 'basic', challenged: true, attempts: 2 });
    expect(server.seen).toEqual(['', AUTHORIZATION]);
    // Neither the header map nor the raw request bytes may carry the credentials to the renderer.
    expect(JSON.stringify(exchange.http.headers)).not.toContain(AUTHORIZATION);
    const rawRequest = Buffer.from(exchange.http.rawRequestBase64, 'base64').toString('utf-8');
    expect(rawRequest).not.toContain(AUTHORIZATION);
    expect(rawRequest).toContain(REDACTED_MARKER);
  });

  it('sends the header up front when preemptive, with a single attempt', async () => {
    const exchange = await service.send(
      {
        sendId: 'send-auth-2',
        input: { endpoint: `${server.url}/soap`, envelopeXml: '<a/>', soapVersion: '1.1' },
      },
      { auth: { type: 'basic', username: 'user', passwordRef: 'ref-1', preemptive: true } },
    );

    expect(exchange.http.status).toBe(200);
    expect(exchange.auth).toEqual({ scheme: 'basic', challenged: false, attempts: 1 });
    expect(server.seen).toEqual([AUTHORIZATION]);
  });

  it('carries no auth summary when the request configures no credentials', async () => {
    const exchange = await service.send({
      sendId: 'send-auth-3',
      input: { endpoint: `${server.url}/soap`, envelopeXml: '<a/>', soapVersion: '1.1' },
    });
    expect(exchange.http.status).toBe(401);
    expect(exchange.auth).toBeUndefined();
  });
});
