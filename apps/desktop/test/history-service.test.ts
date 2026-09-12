import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    expect(history.openProjectIds()).toEqual(['proj-1']);

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

    history.close('proj-1');
    expect(history.openProjectIds()).toEqual([]);
  });

  it('records an entry after a real send, redacting the Authorization header (no plaintext on disk)', async () => {
    const engine = new EngineService();
    const history = new HistoryService(userDataDir);
    await history.open('proj-2');

    const result = await sendAndRecordHistory(
      engine,
      { project: noopProject, history },
      {
        sendId: 'send-1',
        input: {
          endpoint: `${server.url}/soap`,
          envelopeXml: '<soap:Envelope><soap:Body/></soap:Envelope>',
          soapVersion: '1.1',
          headers: { Authorization: 'Basic dG9wc2VjcmV0OnBhc3M=' },
        },
      },
      // No saved request behind this send: it is keyed to the project the caller names.
      { requestName: 'Ad-hoc request', interfaceName: '', operationName: '', projectId: 'proj-2' },
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
        { project: noopProject, history },
        {
          sendId: 'send-err',
          input: {
            endpoint: 'http://127.0.0.1:1/nope',
            envelopeXml: '<Envelope/>',
            soapVersion: '1.1',
            timeoutMs: 200,
          },
        },
        { requestName: 'Ad-hoc request', interfaceName: '', operationName: '', projectId: 'proj-3' },
      ),
    ).rejects.toThrow();

    const { entries } = history.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.ok).toBe(false);
    expect(entries[0]?.error).toBeDefined();
    expect(entries[0]?.status).toBeUndefined();
  });

  it('keys a send to the project owning its request, and records nothing for one no project owns', async () => {
    const engine = new EngineService();
    const history = new HistoryService(userDataDir);
    await history.open('proj-a');
    await history.open('proj-b');
    const owners: Record<string, string> = { 'req-b': 'proj-b' };
    const project = { ...noopProject, projectId: (entityId: string) => owners[entityId] };
    const input = { endpoint: `${server.url}/soap`, envelopeXml: '<Envelope/>', soapVersion: '1.1' as const };

    await sendAndRecordHistory(engine, { project, history }, { sendId: 's-owned', requestId: 'req-b', input });
    // No request, no named project: nothing owns it, so nothing records it.
    await sendAndRecordHistory(engine, { project, history }, { sendId: 's-adhoc', input });

    expect(history.list({ projectId: 'proj-b' }).total).toBe(1);
    expect(history.list({ projectId: 'proj-a' }).total).toBe(0);
    expect(history.list().total).toBe(1);
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
  it('holds one file per open project, merging their entries newest-first', async () => {
    // Only `Date` is faked, so the appends' real file I/O still runs; this just gives every
    // entry a distinct, deterministic timestamp to be merged on.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const history = new HistoryService(userDataDir);
      await history.open('proj-a');
      await history.open('proj-b');
      await history.open('proj-a');
      expect(history.openProjectIds()).toEqual(['proj-a', 'proj-b']);

      const append = async (projectId: string, requestName: string, at: string) => {
        vi.setSystemTime(new Date(at));
        return await history.recordSend(projectId, {
          requestName,
          interfaceName: 'Calc',
          operationName: 'Op',
          input: { endpoint: `${server.url}/soap`, envelopeXml: '<a/>', soapVersion: '1.1' },
          durationMs: 1,
        });
      };
      const names = (result: { entries: { requestName: string }[] }) => result.entries.map((e) => e.requestName);

      await append('proj-a', 'A oldest', '2026-01-01T00:00:01.000Z');
      await append('proj-b', 'B middle', '2026-01-01T00:00:02.000Z');
      const newest = await append('proj-a', 'A newest', '2026-01-01T00:00:03.000Z');

      // A project whose file is not open still records nothing.
      expect(await append('proj-c', 'C', '2026-01-01T00:00:04.000Z')).toBeUndefined();

      expect(names(history.list())).toEqual(['A newest', 'B middle', 'A oldest']);
      expect(history.list().total).toBe(3);
      expect(names(history.list({ limit: 2 }))).toEqual(['A newest', 'B middle']);
      // `total` counts the matches before `limit`.
      expect(history.list({ limit: 2 }).total).toBe(3);
      expect(history.list({ query: 'A ' }).total).toBe(2);

      expect(names(history.list({ projectId: 'proj-a' }))).toEqual(['A newest', 'A oldest']);
      expect(history.list({ projectId: 'proj-a' }).total).toBe(2);
      expect(names(history.list({ projectId: 'proj-b' }))).toEqual(['B middle']);
      expect(history.list({ projectId: 'proj-c' })).toEqual({ entries: [], total: 0 });

      // `get` searches every open file, and stops finding an entry once its file is closed.
      const newestId = newest?.id ?? '';
      expect(history.get(newestId)?.requestName).toBe('A newest');

      // Clearing one project leaves the other's entries alone.
      expect(await history.clear('proj-b')).toBe(1);
      expect(names(history.list())).toEqual(['A newest', 'A oldest']);

      history.close('proj-a');
      expect(history.openProjectIds()).toEqual(['proj-b']);
      expect(history.list()).toEqual({ entries: [], total: 0 });
      expect(history.get(newestId)).toBeUndefined();
      // ...and the closed project's file is untouched on disk.
      expect(await readFile(historyFilePath(userDataDir, 'proj-a'), 'utf8')).toContain('A newest');

      history.closeAll();
      expect(history.openProjectIds()).toEqual([]);
      expect(history.list()).toEqual({ entries: [], total: 0 });
      expect(await history.clear()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The second lock on the door finding 1 opened: a project's id is its own `wirebench.yaml`'s,
 * and a linked project keeps it, so `historyFilePath` must never turn one into a path that
 * leaves `<userData>/history` — `writeFileAtomic` would happily mkdir and write there.
 */
describe('historyFilePath', () => {
  it('builds `<userData>/history/<id>.jsonl` for a normal id', () => {
    expect(historyFilePath('/data', '01J8ABCDEF')).toBe(join('/data', 'history', '01J8ABCDEF.jsonl'));
  });

  it.each([
    ['a parent traversal', '../../../../tmp/x'],
    ['a bare dot-dot', '..'],
    ['a forward slash', 'a/b'],
    ['a backslash', 'a\\b'],
    ['a NUL', 'a\u0000b'],
    ['nothing at all', ''],
  ])('refuses an id holding %s', (_case, id) => {
    expect(() => historyFilePath('/data', id)).toThrow(
      expect.objectContaining({ code: 'workspace-path-invalid' }) as Error,
    );
  });
});
