// @vitest-environment node
/**
 * `sendAndRecordHistory` reports a failed send to `onSendFailed` — the hook main broadcasts
 * `exchange.failed` from — with the request headers already redacted, and stays quiet on success.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineService } from '../src/main/engine-service.js';
import { sendAndRecordHistory } from '../src/main/send-with-history.js';
import type { FailedExchangeWire } from '../src/shared/wire-types.js';

interface EchoServer {
  readonly url: string;
  close(): Promise<void>;
}

async function startEchoServer(): Promise<EchoServer> {
  async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }
  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'text/xml' });
      res.end(body);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

const noopProject = {
  scopesFor: () => ({ project: {}, global: {}, system: process.env }),
  authFor: () => undefined,
  requestMeta: () => undefined,
  projectId: () => 'proj-1',
};

describe('sendAndRecordHistory → onSendFailed', () => {
  let server: EchoServer;

  beforeEach(async () => {
    server = await startEchoServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('reports a refused connection with the redacted headers, then rethrows', async () => {
    const onSendFailed = vi.fn<(failure: FailedExchangeWire) => void>();
    const before = Date.now();

    await expect(
      sendAndRecordHistory(
        new EngineService(),
        { project: noopProject, onSendFailed },
        {
          sendId: 'send-err',
          requestId: 'req-1',
          input: {
            endpoint: 'http://127.0.0.1:1/nope',
            envelopeXml: '<Envelope/>',
            soapVersion: '1.1',
            timeoutMs: 2_000,
            headers: { Authorization: 'Basic dG9wc2VjcmV0OnBhc3M=', 'X-Trace': 'abc' },
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'connection-refused' });

    expect(onSendFailed).toHaveBeenCalledTimes(1);
    const failure = onSendFailed.mock.calls[0]![0];
    expect(failure).toMatchObject({
      sendId: 'send-err',
      protocol: 'soap',
      requestId: 'req-1',
      request: {
        url: 'http://127.0.0.1:1/nope',
        method: 'POST',
        headers: { Authorization: '<redacted>', 'X-Trace': 'abc' },
      },
      error: { code: 'connection-refused' },
    });
    expect(failure.durationMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(failure.startedAt)).toBeGreaterThanOrEqual(before - 1);
    expect(JSON.stringify(failure)).not.toContain('dG9wc2VjcmV0');
    // The headers are the ones the transport was about to send, not only the resolved input's.
    const names = Object.fromEntries(Object.entries(failure.request.headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(names['content-type']).toMatch(/text\/xml/);
    expect(names).toHaveProperty('soapaction');
    const raw = Buffer.from(failure.rawRequestBase64 ?? '', 'base64').toString('utf8');
    expect(raw).toContain('POST /nope HTTP/1.1');
    expect(raw).toContain('<Envelope/>');
    expect(raw).not.toContain('dG9wc2VjcmV0');
  });

  it('keeps the send error when onSendFailed itself throws', async () => {
    const onSendFailed = vi.fn(() => {
      throw new Error('listener broke');
    });

    await expect(
      sendAndRecordHistory(
        new EngineService(),
        { project: noopProject, onSendFailed },
        {
          sendId: 'send-err-2',
          input: {
            endpoint: 'http://127.0.0.1:1/nope',
            envelopeXml: '<Envelope/>',
            soapVersion: '1.1',
            timeoutMs: 2_000,
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'connection-refused' });
    expect(onSendFailed).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the send succeeds', async () => {
    const onSendFailed = vi.fn();

    const result = await sendAndRecordHistory(
      new EngineService(),
      { project: noopProject, onSendFailed },
      {
        sendId: 'send-ok',
        input: {
          endpoint: `${server.url}/soap`,
          envelopeXml: '<soap:Envelope><soap:Body/></soap:Envelope>',
          soapVersion: '1.1',
        },
      },
    );

    expect(result.http.status).toBe(200);
    expect(onSendFailed).not.toHaveBeenCalled();
  });
});
