/**
 * The recording proxy (#60, spec §Engine) with a fake protocol facet and a local upstream: path
 * mapping, forwarded and relayed headers, decompression, upstream failures, the host check, what is
 * and is not recorded, masking, the charset rewrite and an invalid target.
 */
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { isWirebenchError } from '../../../src/errors.js';
import type { MockContract, MockReply, ProtocolMocking } from '../../../src/mock/contract.js';
import { MOCK_LIMITS, createMock } from '../../../src/mock/model.js';
import type { MockDef } from '../../../src/mock/model.js';
import { startRecorder } from '../../../src/mock/record.js';
import type { RecordExchangeEvent, RunningRecorder, StartRecorderInput } from '../../../src/mock/record.js';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { createProtocolRegistry } from '../../../src/protocol/registry.js';
import { createApi } from '../../../src/rest/model.js';
import { restProtocol } from '../../../src/rest/module.js';

const plain = (status: number, body: string): MockReply => ({
  status,
  headers: [['Content-Type', 'text/plain']],
  body,
});

/** `/m/unrouted…` is refused; `?wsdl` is a definition; anything else is operation `op`. */
const fakeContract: MockContract = {
  operations: [{ key: 'op', name: 'Op' }],
  definition: (request) => (request.query['wsdl'] !== undefined ? plain(200, 'definition') : undefined),
  route: (request) =>
    Promise.resolve(
      request.path.startsWith('/m/unrouted')
        ? {
            kind: 'refused',
            problems: [{ code: 'mock-operation-not-found', message: 'no such' }],
            reply: plain(404, ''),
          }
        : { kind: 'operation', operation: 'op', problems: [], view: { bodyKind: 'other', pathParams: {} } },
    ),
  fail: (code, message) => plain(500, `${code}: ${message}`),
  defaults: () => [],
};
const fakeMocking: ProtocolMocking = {
  open: () => Promise.resolve(fakeContract),
  generate: () => Promise.resolve({ operations: [] }),
};
const registry = createProtocolRegistry([{ ...restProtocol, mock: fakeMocking }]);

const mock: MockDef = createMock('M', { containerId: 'A1' }, { id: 'M1', path: '/m' });
const project: Project = {
  ...createProject('P', { id: 'P1' }),
  containers: { rest: [createApi('Api', { id: 'A1' })] },
  mocks: [mock],
};

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** What the upstream answers. */
type Answer = (seen: Seen) => {
  status?: number;
  headers?: Record<string, string | string[]>;
  body?: string | Buffer;
  hang?: boolean;
};

const servers: Server[] = [];
const recorders: RunningRecorder[] = [];
afterEach(async () => {
  await Promise.all(recorders.splice(0).map((r) => r.stop()));
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
});

async function upstream(answer: Answer, seen: Seen[] = []): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      seen.push(entry);
      const a = answer(entry);
      if (a.hang === true) return;
      res.writeHead(a.status ?? 200, a.headers ?? {});
      res.end(a.body ?? '');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`;
}

async function record(
  target: string,
  events: RecordExchangeEvent[] = [],
  over: Partial<StartRecorderInput> = {},
): Promise<RunningRecorder> {
  const recorder = await startRecorder({
    project,
    root: '/nowhere',
    mockId: 'M1',
    target,
    port: 0,
    registry,
    onExchange: (e) => events.push(e),
    ...over,
  });
  recorders.push(recorder);
  return recorder;
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function send(
  recorder: RunningRecorder,
  path: string,
  options: { method?: string; host?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: recorder.port,
        path,
        method: options.method ?? 'GET',
        agent: false,
        headers: { Host: options.host ?? `localhost:${String(recorder.port)}`, ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

describe('startRecorder', () => {
  it('forwards under the target path, relays the response and records it', async () => {
    const seen: Seen[] = [];
    const target = await upstream(
      () => ({ status: 201, headers: { 'Content-Type': 'application/json', 'X-Trace': 't1' }, body: '{"id":7}' }),
      seen,
    );
    const events: RecordExchangeEvent[] = [];
    const recorder = await record(`${target}/api/v2/`, events);
    const reply = await send(recorder, '/m/orders/7?x=1&y=2', {
      method: 'POST',
      body: '{"qty":1}',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer live-token' },
    });
    expect(reply).toMatchObject({ status: 201, body: '{"id":7}' });
    expect(reply.headers['x-trace']).toBe('t1');
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/v2/orders/7?x=1&y=2', body: '{"qty":1}' });
    // The real credential reaches the upstream: only what is kept is masked.
    expect(seen[0]?.headers.authorization).toBe('Bearer live-token');
    expect(seen[0]?.headers.host).toBe(new URL(target).host);
    // undici reports header names in lower case; HTTP compares them case-insensitively.
    expect(recorder.recordings()).toEqual([
      {
        operation: 'op',
        operationName: 'Op',
        status: 201,
        headers: [
          { name: 'content-type', value: 'application/json' },
          { name: 'x-trace', value: 't1' },
        ],
        body: 'json',
        bodyText: '{"id":7}',
      },
    ]);
    expect(events[0]).toMatchObject({
      method: 'POST',
      status: 201,
      operation: 'op',
      recorded: true,
      url: '/m/orders/7?x=1&y=2',
    });
    expect(events[0]?.request.headers).toContainEqual(['Authorization', '<redacted>']);
  });

  it('maps the mock path itself onto the target path', async () => {
    const seen: Seen[] = [];
    const target = await upstream(() => ({ body: 'ok' }), seen);
    const recorder = await record(`${target}/svc`);
    await send(recorder, '/m');
    const bare = await record(target);
    await send(bare, '/m');
    expect(seen.map((s) => s.url)).toEqual(['/svc', '/']);
  });

  it('refuses a path outside the mock, an unknown method and a non-loopback Host without forwarding', async () => {
    const seen: Seen[] = [];
    const events: RecordExchangeEvent[] = [];
    const recorder = await record(await upstream(() => ({}), seen), events);
    expect((await send(recorder, '/elsewhere')).status).toBe(404);
    expect((await send(recorder, '/m/x', { method: 'PROPFIND' })).status).toBe(501);
    expect((await send(recorder, '/m/x', { host: 'evil.example' })).status).toBe(421);
    expect(seen).toHaveLength(0);
    expect(events.map((e) => e.error?.code)).toEqual([
      'mock-operation-not-found',
      'mock-record-upstream-failed',
      'mock-host-refused',
    ]);
  });

  it('relays a gzip body decompressed, and keeps it without Content-Encoding or Date', async () => {
    const recorder = await record(
      await upstream(() => ({
        headers: { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip', Date: 'Thu, 01 Jan 2026 00:00:00 GMT' },
        body: gzipSync('hello'),
      })),
    );
    const reply = await send(recorder, '/m/x', { headers: { 'Accept-Encoding': 'gzip' } });
    expect(reply.body).toBe('hello');
    expect(reply.headers['content-encoding']).toBeUndefined();
    expect(recorder.recordings()[0]?.headers.map((h) => h.name)).toEqual(['content-type']);
    expect(recorder.recordings()[0]).toMatchObject({ body: 'text', bodyText: 'hello' });
  });

  it('answers 502 when the target is down and 504 when it times out', async () => {
    const events: RecordExchangeEvent[] = [];
    const down = await record('http://127.0.0.1:1/', events);
    const refused = await send(down, '/m/x');
    expect(refused).toMatchObject({ status: 502, body: 'The recorder could not reach the target\n' });
    const slow = await record(await upstream(() => ({ hang: true })), events, { timeoutMs: 200 });
    expect((await send(slow, '/m/x')).status).toBe(504);
    expect(events.map((e) => e.error?.code)).toEqual(['mock-record-upstream-failed', 'mock-record-upstream-failed']);
    expect(down.recordings()).toEqual([]);
    // The cause stays in the log, never in the client's reply.
    expect(events[0]?.error?.message).not.toBe('');
  });

  it('relays without recording a definition request, an unrouted request and a binary body', async () => {
    const events: RecordExchangeEvent[] = [];
    const recorder = await record(
      await upstream((seen) =>
        seen.url.includes('bin')
          ? { headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from([0, 1, 2]) }
          : { body: 'x' },
      ),
      events,
    );
    expect((await send(recorder, '/m?wsdl')).body).toBe('x');
    expect((await send(recorder, '/m/unrouted')).body).toBe('x');
    expect((await send(recorder, '/m/bin')).status).toBe(200);
    expect(recorder.recordings()).toEqual([]);
    expect(events.map((e) => [e.recorded, e.problems[0]?.code])).toEqual([
      [false, undefined],
      [false, 'mock-record-unrouted'],
      [false, 'mock-record-binary'],
    ]);
  });

  it('relays but does not keep a body over the stub limit', async () => {
    const events: RecordExchangeEvent[] = [];
    const big = 'x'.repeat(MOCK_LIMITS.bodyBytes + 1);
    const recorder = await record(
      await upstream(() => ({ headers: { 'Content-Type': 'text/plain' }, body: big })),
      events,
    );
    expect((await send(recorder, '/m/x')).body.length).toBe(big.length);
    expect(recorder.recordings()).toEqual([]);
    expect(events[0]?.problems[0]?.code).toBe('mock-record-too-large');
    expect(events[0]?.response.truncated).toBe(true);
  });

  it('keeps an empty body as none', async () => {
    const recorder = await record(await upstream(() => ({ status: 204 })));
    await send(recorder, '/m/x', { method: 'DELETE' });
    expect(recorder.recordings()[0]).toMatchObject({ status: 204, body: 'none', bodyText: '' });
  });

  it('masks credentials in kept headers and bodies, and known secret values', async () => {
    const xml =
      '<s:Envelope xmlns:s="urn:s"><s:Header><wsse:Password xmlns:wsse="urn:w">hunter22</wsse:Password></s:Header>' +
      '<s:Body><r>key=Sup3rSecretValue&amp;x</r></s:Body></s:Envelope>';
    const recorder = await record(
      await upstream((seen) =>
        seen.url.endsWith('/json')
          ? {
              headers: { 'Content-Type': 'application/json', 'Set-Cookie': ['sid=abc', 'other=def'] },
              body: '{"access_token":"tok-123","name":"Sup3rSecretValue"}',
            }
          : seen.url.endsWith('/form')
            ? { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=pw1&user=u' }
            : { headers: { 'Content-Type': 'text/xml; charset=utf-8', 'X-Echo': 'Sup3rSecretValue' }, body: xml },
      ),
      [],
      { secrets: ['Sup3rSecretValue'] },
    );
    await send(recorder, '/m/json');
    await send(recorder, '/m/form');
    const relayed = await send(recorder, '/m/xml');
    expect(relayed.body).toBe(xml);
    const [json, form, soap] = recorder.recordings();
    expect(json?.headers.filter((h) => h.name === 'set-cookie')).toEqual([
      { name: 'set-cookie', value: '<redacted>' },
      { name: 'set-cookie', value: '<redacted>' },
    ]);
    expect(JSON.parse(json?.bodyText ?? '')).toEqual({ access_token: '<redacted>', name: '<redacted>' });
    expect(form?.bodyText).not.toContain('pw1');
    expect(form?.bodyText).toContain('user=u');
    expect(soap?.bodyText).not.toContain('hunter22');
    expect(soap?.bodyText).not.toContain('Sup3rSecretValue');
    expect(soap?.bodyText).toContain('&lt;redacted&gt;');
    expect(soap?.headers).toContainEqual({ name: 'x-echo', value: '<redacted>' });
  });

  it('keeps a JSON body as the server wrote it when nothing in it is masked', async () => {
    const recorder = await record(
      await upstream(() => ({ headers: { 'Content-Type': 'application/json' }, body: '{ "n": 1.0 }' })),
    );
    await send(recorder, '/m/x');
    expect(recorder.recordings()[0]?.bodyText).toBe('{ "n": 1.0 }');
  });

  it('decodes another charset and says utf-8 in the kept Content-Type', async () => {
    const recorder = await record(
      await upstream(() => ({
        headers: { 'Content-Type': 'text/plain; charset=iso-8859-1' },
        body: Buffer.from('café', 'latin1'),
      })),
    );
    await send(recorder, '/m/x');
    expect(recorder.recordings()[0]).toMatchObject({
      bodyText: 'café',
      headers: [{ name: 'content-type', value: 'text/plain; charset=utf-8' }],
    });
  });

  it('forwards the query, and drops conditional and Connection-named headers', async () => {
    const seen: Seen[] = [];
    const recorder = await record(await upstream(() => ({ body: 'ok' }), seen));
    await send(recorder, '/m/x?sig=ab&n=%7e', {
      headers: {
        'If-None-Match': '"v1"',
        'If-Modified-Since': 'Thu, 01 Jan 2026 00:00:00 GMT',
        Connection: 'X-Hop',
        'X-Hop': '1',
        'X-Keep': '2',
      },
    });
    expect(seen[0]?.url).toBe('/x?sig=ab&n=%7e');
    expect(seen[0]?.headers['if-none-match']).toBeUndefined();
    expect(seen[0]?.headers['if-modified-since']).toBeUndefined();
    expect(seen[0]?.headers['x-hop']).toBeUndefined();
    expect(seen[0]?.headers['x-keep']).toBe('2');
  });

  it('keeps the upstream length on a HEAD reply and sends none on a 204', async () => {
    const recorder = await record(
      await upstream((seen) =>
        seen.method === 'HEAD'
          ? { headers: { 'Content-Type': 'text/plain', 'Content-Length': '42' } }
          : { status: 204 },
      ),
    );
    const head = await send(recorder, '/m/x', { method: 'HEAD' });
    expect(head.headers['content-length']).toBe('42');
    const empty = await send(recorder, '/m/x', { method: 'DELETE' });
    expect(empty.status).toBe(204);
    expect(empty.headers['content-length']).toBeUndefined();
  });

  it('masks secret keys in JSON served as text', async () => {
    const recorder = await record(
      await upstream(() => ({ headers: { 'Content-Type': 'text/plain' }, body: '{"password":"pw-123","n":1}' })),
    );
    await send(recorder, '/m/x');
    expect(JSON.parse(recorder.recordings()[0]?.bodyText ?? '')).toEqual({ password: '<redacted>', n: 1 });
  });

  it('refuses a target that is not an http or https URL', async () => {
    for (const target of ['not a url', 'file:///etc/passwd', 'https://user:pass@real.example/']) {
      const error = await startRecorder({ project, root: '/', mockId: 'M1', target, registry }).catch(
        (e: unknown) => e,
      );
      expect(isWirebenchError(error) && error.code).toBe('mock-record-target-invalid');
    }
  });

  it('stop() closes the listener', async () => {
    const recorder = await record(await upstream(() => ({})));
    await recorder.stop();
    await expect(send(recorder, '/m/x')).rejects.toThrow();
  });
});
