import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInterface, createProject, createRequest, type Project } from '@wirebench/engine';
import { HistoryService, historyFilePath } from '../src/main/history-service.js';
import { AD_HOC_ID, soapOverrideOf } from '../src/main/send/draft.js';
import { sendThroughEngine } from '../src/main/send/exchange.js';
import { AD_HOC_NAME, type HistoryNameFallback } from '../src/main/send/record.js';
import type { ResolvedSendInputWire } from '../src/shared/wire-types.js';
import { sendDepsFor } from './helpers/send-deps.js';

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

/** A project holding one SOAP request, `req-b`, at `endpointUrl`. */
function holding(endpointUrl: string): Project {
  const request = {
    ...createRequest('Add', { id: 'req-b', envelopeXml: '<Envelope/>', soapVersion: '1.1' }),
    endpointUrl,
  };
  const iface = createInterface('Calc', {
    id: 'iface-1',
    definitionUrl: 'http://127.0.0.1:1/calc?wsdl',
    cacheDefinition: false,
    operations: [{ name: 'Add', bindingName: '{urn:calc}B', slug: 'add', order: 0, requests: [request] }],
  });
  return { ...createProject('Demo', { id: 'proj-b' }), interfaces: [iface] };
}

/** Sends `input` ad hoc through the engine, recorded under `names`, as `request.send` does with no request. */
function sendAdHoc(history: HistoryService, sendId: string, input: ResolvedSendInputWire, names: HistoryNameFallback) {
  return sendThroughEngine(sendDepsFor(createProject('None', { id: 'none' }), { history }), sendId, AD_HOC_ID, {
    draft: { kind: 'soap', override: soapOverrideOf(input) },
    adHoc: { input, names },
  });
}

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
    const history = new HistoryService(userDataDir);
    await history.open('proj-2');

    const result = await sendAdHoc(
      history,
      'send-1',
      {
        endpoint: `${server.url}/soap`,
        envelopeXml: '<soap:Envelope><soap:Body/></soap:Envelope>',
        soapVersion: '1.1',
        headers: { Authorization: 'Basic dG9wc2VjcmV0OnBhc3M=' },
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
    const history = new HistoryService(userDataDir);
    await history.open('proj-3');

    await expect(
      sendAdHoc(
        history,
        'send-err',
        { endpoint: 'http://127.0.0.1:1/nope', envelopeXml: '<Envelope/>', soapVersion: '1.1', timeoutMs: 200 },
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
    const history = new HistoryService(userDataDir);
    await history.open('proj-a');
    await history.open('proj-b');
    const owners: Record<string, string> = { 'req-b': 'proj-b' };
    const input = { endpoint: `${server.url}/soap`, envelopeXml: '<Envelope/>', soapVersion: '1.1' as const };

    const deps = sendDepsFor(holding(`${server.url}/soap`), {
      history,
      project: { projectId: (entityId: string) => owners[entityId] },
    });
    await sendThroughEngine(deps, 's-owned', 'req-b', { draft: { kind: 'soap' } });
    // No request, no named project: nothing owns it, so nothing records it.
    await sendAdHoc(history, 's-adhoc', input, AD_HOC_NAME);

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
  it("finds a request's newest REST entry in its own project", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const history = new HistoryService(userDataDir);
      await history.open('p1');
      const append = async (requestId: string, url: string, at: string) => {
        vi.setSystemTime(new Date(at));
        return await history.recordRestSend('p1', {
          requestId,
          requestName: requestId,
          apiName: 'Petstore',
          folderPath: '',
          method: 'POST',
          url,
          requestHeaders: {},
          requestBody: '',
          durationMs: 1,
        });
      };
      await append('a', 'https://api.test/first', '2026-01-01T00:00:01.000Z');
      const later = await append('a', 'https://api.test/second', '2026-01-01T00:00:02.000Z');
      await append('b', 'https://api.test/other', '2026-01-01T00:00:03.000Z');

      expect(history.newestFor('p1', 'a')?.id).toBe(later?.id);
      expect(history.newestFor('p1', 'a')?.endpoint).toBe('https://api.test/second');
      expect(history.newestFor('p1', 'zzz')).toBeUndefined();
      expect(history.newestFor('p2', 'a')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
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
 * Another writer (`wirebench mcp`, a CLI send) may hold the History lock when a desktop send
 * finishes. The send succeeded; a busy History file must not turn it into a failed one.
 */
describe('HistoryService when another writer holds the History lock', () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'wirebench-history-busy-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(userDataDir, { recursive: true, force: true });
  });

  it('skips the entry and warns, instead of failing the send', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const history = new HistoryService(userDataDir);
    await history.open('proj-1');
    const file = historyFilePath(userDataDir, 'proj-1');
    // A lock file with a fresh mtime is a live writer's: the append waits the engine's default 2 s.
    await mkdir(join(userDataDir, 'history'), { recursive: true });
    await writeFile(`${file}.lock`, 'other-writer');

    const recorded = await history.recordRestSend('proj-1', {
      requestId: 'req-1',
      requestName: 'List pets',
      apiName: 'Pets',
      folderPath: '',
      method: 'GET',
      url: 'http://127.0.0.1:9/pets',
      requestHeaders: {},
      requestBody: '',
      durationMs: 4,
      error: { code: 'http-connect-failed', message: 'connection refused' },
    });

    expect(recorded).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/proj-1.*skipped.*History file was busy/);
    expect(history.list().entries).toEqual([]);
  }, 15_000);

  it('rethrows any other append error, without a busy warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const history = new HistoryService(userDataDir);
    await history.open('proj-1');
    // A directory where the file should be makes the append's reread fail with something other than a busy lock.
    await mkdir(historyFilePath(userDataDir, 'proj-1'), { recursive: true });

    await expect(
      history.recordRestSend('proj-1', {
        requestId: 'req-1',
        requestName: 'List pets',
        apiName: 'Pets',
        folderPath: '',
        method: 'GET',
        url: 'http://127.0.0.1:9/pets',
        requestHeaders: {},
        requestBody: '',
        durationMs: 4,
        error: { code: 'http-connect-failed', message: 'connection refused' },
      }),
    ).rejects.toThrow();

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('HistoryService.recordImportedRest', () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'wirebench-history-import-'));
  });

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true });
  });

  /** One recorded exchange carrying a credential in every place a capture can hold one. */
  const RECORDED = {
    requestId: 'r1',
    requestName: 'POST /login',
    apiName: 'api.example.com',
    at: '2026-10-01T10:00:00.000Z',
    durationMs: 42,
    method: 'POST',
    url: 'https://api.example.com/login?token=qtok-123&limit=5',
    requestHeaders: [
      { name: 'Authorization', value: 'Bearer abc-secret' },
      { name: 'Cookie', value: 'sid=cookie-in' },
      { name: 'Content-Type', value: 'application/json' },
    ],
    requestBody: '{"user":"ann","password":"hunter2-pw"}',
    status: 200,
    statusText: 'OK',
    responseHeaders: [
      { name: 'Set-Cookie', value: 'sid=cookie-out; HttpOnly' },
      { name: 'Content-Type', value: 'application/json; charset=utf-8' },
    ],
    responseBody: '{"ok":true,"access_token":"atok-456"}',
    tags: ['imported:har'],
  } as const;

  it('records an imported exchange at its recorded time, tagged', async () => {
    const history = new HistoryService(userDataDir);
    await history.open('proj-1');

    const entry = await history.recordImportedRest('proj-1', RECORDED);

    expect(entry).toMatchObject({
      kind: 'rest',
      at: '2026-10-01T10:00:00.000Z',
      method: 'POST',
      status: 200,
      ok: true,
      durationMs: 42,
      requestId: 'r1',
      requestName: 'POST /login',
      interfaceName: 'api.example.com',
      tags: ['imported:har'],
    });
    expect(entry?.request.envelopeXml).toContain('"user":"ann"');
    expect(entry?.response?.envelopeXml).toContain('"ok":true');
    expect(history.list({ projectId: 'proj-1' }).entries).toHaveLength(1);
  });

  it('writes no recorded credential to the History file', async () => {
    const history = new HistoryService(userDataDir);
    await history.open('proj-1');

    const entry = await history.recordImportedRest('proj-1', RECORDED);
    const onDisk = await readFile(historyFilePath(userDataDir, 'proj-1'), 'utf8');

    for (const text of [JSON.stringify(entry), onDisk]) {
      expect(text).not.toContain('abc-secret');
      expect(text).not.toContain('cookie-in');
      expect(text).not.toContain('cookie-out');
      expect(text).not.toContain('qtok-123');
      expect(text).not.toContain('hunter2-pw');
      expect(text).not.toContain('atok-456');
    }
    expect(entry?.endpoint).toContain('limit=5');
  });

  it('answers undefined when the project History is not open', async () => {
    const history = new HistoryService(userDataDir);

    expect(await history.recordImportedRest('proj-1', RECORDED)).toBeUndefined();
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
