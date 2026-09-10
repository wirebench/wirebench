import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService, historyFilePath } from '../src/main/history-service.js';
import { sendAndRecordHistory } from '../src/main/send-with-history.js';

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

describe('HistoryService', () => {
  let server: EchoServer;
  let userDataDir: string;

  beforeEach(async () => {
    server = await startEchoServer();
    userDataDir = await mkdtemp(join(tmpdir(), 'wirebench-history-'));
  });

  afterEach(async () => {
    await server.close();
    await rm(userDataDir, { recursive: true, force: true });
  });

  it('opens per project, at <userData>/history/<projectId>.jsonl', async () => {
    const history = new HistoryService(userDataDir);
    await history.open('proj-1');
    expect(history.projectId).toBe('proj-1');

    await history.recordSend('proj-1', {
      requestName: 'Add',
      interfaceName: 'Calc',
      operationName: 'Add',
      input: { endpoint: `${server.url}/soap`, envelopeXml: '<Envelope/>', soapVersion: '1.1', headers: {} },
      durationMs: 5,
    });

    const path = historyFilePath(userDataDir, 'proj-1');
    const onDisk = await readFile(path, 'utf8');
    expect(onDisk.trim().length).toBeGreaterThan(0);

    history.close();
    expect(history.projectId).toBeUndefined();
  });

  it('records an entry after a real send, redacting the Authorization header (no plaintext on disk)', async () => {
    const engine = new EngineService();
    const history = new HistoryService(userDataDir);
    await history.open('proj-2');

    const result = await sendAndRecordHistory(
      engine,
      { project: { ...noopProject, projectId: () => 'proj-2' }, history },
      {
        sendId: 'send-1',
        input: {
          endpoint: `${server.url}/soap`,
          envelopeXml: '<soap:Envelope><soap:Body/></soap:Envelope>',
          soapVersion: '1.1',
          headers: { Authorization: 'Basic dG9wc2VjcmV0OnBhc3M=' },
        },
      },
    );
    expect(result.http.status).toBe(200);

    const { entries } = history.list();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.ok).toBe(true);
    expect(entry?.status).toBe(200);
    expect(entry?.requestName).toBe('Ad-hoc request');
    const authHeader = entry?.request.headers.find((h) => h.name.toLowerCase() === 'authorization');
    expect(authHeader?.value).toBe('<redacted>');

    const onDiskRaw = await readFile(historyFilePath(userDataDir, 'proj-2'), 'utf8');
    expect(onDiskRaw).not.toContain('dG9wc2VjcmV0OnBhc3M=');
    expect(onDiskRaw).not.toContain('topsecret');
  });

  it('records a transport-error entry when the send fails', async () => {
    const engine = new EngineService();
    const history = new HistoryService(userDataDir);
    await history.open('proj-3');

    await expect(
      sendAndRecordHistory(
        engine,
        { project: { ...noopProject, projectId: () => 'proj-3' }, history },
        {
          sendId: 'send-err',
          input: {
            endpoint: 'http://127.0.0.1:1/nope',
            envelopeXml: '<Envelope/>',
            soapVersion: '1.1',
            timeoutMs: 200,
          },
        },
      ),
    ).rejects.toThrow();

    const { entries } = history.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.ok).toBe(false);
    expect(entries[0]?.error).toBeDefined();
    expect(entries[0]?.status).toBeUndefined();
  });

  it('list search filters and clear empties the file', async () => {
    const history = new HistoryService(userDataDir);
    await history.open('proj-4');
    await history.recordSend('proj-4', {
      requestName: 'GetWeather',
      interfaceName: 'Weather',
      operationName: 'Get',
      input: { endpoint: `${server.url}/soap`, envelopeXml: '<a/>', soapVersion: '1.1' },
      durationMs: 1,
    });
    await history.recordSend('proj-4', {
      requestName: 'Other',
      interfaceName: 'Calc',
      operationName: 'Sub',
      input: { endpoint: `${server.url}/soap`, envelopeXml: '<a/>', soapVersion: '1.1' },
      durationMs: 1,
    });

    expect(history.list({ query: 'weather' }).total).toBe(1);
    expect(history.list().total).toBe(2);

    const cleared = await history.clear();
    expect(cleared).toBe(2);
    expect(history.list().entries).toEqual([]);
  });
});
