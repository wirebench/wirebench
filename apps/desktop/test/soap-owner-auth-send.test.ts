// @vitest-environment node
/**
 * A SOAP send with a token owner auth (Bearer, API key, OAuth2): main resolves the reference or
 * the access token before the wire, a failure there is a `prepare` row with no History entry, and
 * an API key in the query string is masked on every surface a URL reaches.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WirebenchError, type SoapOwnerAuth } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { redactExchangeSummary } from '../src/main/engine-wire.js';
import { harOf } from '../src/main/har.js';
import { buildHistoryEntry, type RecordSendInput } from '../src/main/history-service.js';
import { sendAndRecordHistory } from '../src/main/send-with-history.js';
import type { FailedExchangeWire, LogEntryWire } from '../src/shared/wire-types.js';

interface Seen {
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
}

interface CaptureServer {
  readonly url: string;
  readonly seen: Seen[];
  close(): Promise<void>;
}

async function startCaptureServer(): Promise<CaptureServer> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end('<Envelope/>');
    });
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

const OAUTH2: SoapOwnerAuth = {
  type: 'oauth2',
  grant: 'client-credentials',
  tokenUrl: 'https://auth.example/token',
  clientId: 'cid',
} as SoapOwnerAuth;

function projectWith(auth: SoapOwnerAuth | undefined) {
  return {
    scopesFor: () => ({ project: {}, global: {}, system: {} }),
    authFor: () => auth,
    requestMeta: () => ({ requestName: 'R', interfaceName: 'I', operationName: 'O' }),
    projectId: () => 'proj-1',
  };
}

const secrets: Record<string, string> = { 'ref-token': 's3cr3t-token', 'ref-key': 'my key' };
const getSecret = (ref: string): Promise<string | undefined> => Promise.resolve(secrets[ref]);

describe('SOAP send with a token owner auth', () => {
  let server: CaptureServer;

  beforeEach(async () => {
    server = await startCaptureServer();
  });

  afterEach(async () => {
    await server.close();
  });

  const request = (sendId: string) => ({
    sendId,
    requestId: 'req-1',
    input: {
      endpoint: `${server.url}/calc`,
      envelopeXml: '<Envelope/>',
      soapVersion: '1.1' as const,
      timeoutMs: 2_000,
    },
  });

  it('an OAuth2 owner fetches the token once and sends it as Bearer', async () => {
    const accessToken = vi.fn(() => Promise.resolve('tok-123'));
    await sendAndRecordHistory(
      new EngineService(getSecret),
      { project: projectWith(OAUTH2), oauth2: { accessToken }, getSecret },
      request('s-oauth'),
    );
    expect(accessToken).toHaveBeenCalledTimes(1);
    expect(server.seen[0]!.headers.authorization).toBe('Bearer tok-123');
  });

  it('a token request that fails is a prepare row and writes no History entry', async () => {
    const onSendFailed = vi.fn<(failure: FailedExchangeWire) => void>();
    const recordSend = vi.fn(() => Promise.resolve(undefined));
    const accessToken = vi.fn(() => Promise.reject(new WirebenchError('oauth2-token-failed', 'denied')));
    await expect(
      sendAndRecordHistory(
        new EngineService(getSecret),
        {
          project: projectWith(OAUTH2),
          oauth2: { accessToken },
          getSecret,
          onSendFailed,
          history: { recordSend } as never,
        },
        request('s-oauth-fail'),
      ),
    ).rejects.toThrow('denied');
    expect(onSendFailed.mock.calls[0]![0]).toMatchObject({ stage: 'prepare', error: { code: 'oauth2-token-failed' } });
    expect(recordSend).not.toHaveBeenCalled();
    expect(server.seen).toHaveLength(0);
  });

  it('a dangling tokenRef is a secret-missing prepare row', async () => {
    const onSendFailed = vi.fn<(failure: FailedExchangeWire) => void>();
    const recordSend = vi.fn(() => Promise.resolve(undefined));
    await expect(
      sendAndRecordHistory(
        new EngineService(getSecret),
        {
          project: projectWith({ type: 'bearer', tokenRef: 'ref-gone' }),
          getSecret,
          onSendFailed,
          history: { recordSend } as never,
        },
        request('s-dangling'),
      ),
    ).rejects.toMatchObject({ code: 'secret-missing' });
    expect(onSendFailed.mock.calls[0]![0]).toMatchObject({ stage: 'prepare', error: { code: 'secret-missing' } });
    expect(recordSend).not.toHaveBeenCalled();
    expect(server.seen).toHaveLength(0);
  });

  it('a query API key goes on the wire and is masked in the summary, History and HAR', async () => {
    const recordSend = vi.fn<(projectId: string, record: RecordSendInput) => Promise<undefined>>(() =>
      Promise.resolve(undefined),
    );
    const service = new EngineService(getSecret);
    const auth: SoapOwnerAuth = { type: 'api-key', name: 'api key', valueRef: 'ref-key', in: 'query' };
    const summary = await sendAndRecordHistory(
      service,
      { project: projectWith(auth), getSecret, history: { recordSend } as never },
      request('s-key'),
    );
    // On the wire, percent-encoded as one appended pair: a space is `%20`.
    expect(server.seen[0]!.url).toBe('/calc?api%20key=my%20key');
    // Masked whichever way the key is spelt: percent-encoded, form-encoded or raw.
    const KEY = /my(%20|\+|\s)key/;
    expect(summary.http.request.url).not.toMatch(KEY);
    expect(summary.http.request.url).toContain('api+key=%3Credacted%3E');
    expect(Buffer.from(summary.http.rawRequestBase64, 'base64').toString('latin1')).not.toMatch(KEY);
    // A later `exchanges.get` re-render masks it the same way, and shows it with show-secrets.
    const full = service.exchanges.get('s-key')!;
    const keyParams = service.exchanges.getExchange('s-key')?.keyParams;
    expect(keyParams).toEqual(['api key']);
    expect(redactExchangeSummary(full, { show: false, keyParams: keyParams! }).http.request.url).not.toMatch(KEY);
    expect(redactExchangeSummary(full, { show: true, keyParams: keyParams! }).http.request.url).toMatch(KEY);
    // A redirect's first hop is the wire URL, key included: masked like the request URL.
    const redirected = { ...full, http: { ...full.http, redirects: [{ url: full.http.request.url, status: 302 }] } };
    const hops = redactExchangeSummary(redirected, { show: false, keyParams: keyParams! }).http.redirects;
    expect(hops[0]!.url).not.toMatch(KEY);
    expect(hops[0]!.url).toContain('redacted');
    // History stores the endpoint as configured, never the one carrying the key.
    const [projectId, record] = recordSend.mock.calls[0]!;
    expect(JSON.stringify(buildHistoryEntry(projectId, record))).not.toMatch(KEY);
    // HAR is built from the log row, which carries the already-masked summary.
    const entry = { kind: 'exchange', protocol: 'soap', exchange: summary } as unknown as LogEntryWire;
    expect(JSON.stringify(harOf([entry], { name: 'Wirebench', version: '0' }))).not.toMatch(KEY);
  });

  it('a query API key is masked in the failed row, in both encodings', async () => {
    const onSendFailed = vi.fn<(failure: FailedExchangeWire) => void>();
    const auth: SoapOwnerAuth = { type: 'api-key', name: 'api key', valueRef: 'ref-key', in: 'query' };
    await expect(
      sendAndRecordHistory(
        new EngineService(getSecret),
        { project: projectWith(auth), getSecret, onSendFailed },
        { ...request('s-key-fail'), input: { ...request('s-key-fail').input, endpoint: 'http://127.0.0.1:1/nope' } },
      ),
    ).rejects.toMatchObject({ code: 'connection-refused' });
    const failure = onSendFailed.mock.calls[0]![0];
    expect(failure.request.url).toContain('api+key=%3Credacted%3E');
    const json = JSON.stringify(failure) + Buffer.from(failure.rawRequestBase64 ?? '', 'base64').toString('latin1');
    expect(json).not.toContain('my+key');
    expect(json).not.toContain('my%20key');
  });
});
