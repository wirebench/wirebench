/**
 * The mock server (spec §Running a mock), with a fake protocol facet so only the core is under test:
 * routing to dispatch, the reply, the host check, the body cap, delays, stop, the log event and the
 * start errors.
 */
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { isWirebenchError } from '../../../src/errors.js';
import { createGrpcApi } from '../../../src/grpc/model.js';
import { grpcProtocol } from '../../../src/grpc/module.js';
import type { MockContract, MockReply, ProtocolMocking } from '../../../src/mock/contract.js';
import { createMock, createMockOperation, createMockResponse } from '../../../src/mock/model.js';
import type { MockDef } from '../../../src/mock/model.js';
import { MOCK_REQUEST_BODY_BYTES, startMock } from '../../../src/mock/server.js';
import type { MockExchangeEvent, RunningMock } from '../../../src/mock/server.js';
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

/** Routes `/m/op` to operation `op`, `/m/refuse` to a refusal, anything else to `fail`. */
const fakeContract: MockContract = {
  operations: [
    { key: 'op', name: 'Op' },
    { key: 'empty', name: 'Empty' },
  ],
  definition: (request) => (request.query['wsdl'] !== undefined ? plain(200, 'definition') : undefined),
  route: (request) => {
    if (request.path === '/m/refuse') {
      return Promise.resolve({
        kind: 'refused',
        problems: [{ code: 'mock-request-invalid', message: 'nope' }],
        reply: plain(400, 'refused'),
      });
    }
    const operation = request.path === '/m/empty' ? 'empty' : 'op';
    return Promise.resolve({ kind: 'operation', operation, problems: [], view: { bodyKind: 'other', pathParams: {} } });
  },
  fail: (code, message) => plain(code === 'mock-no-stub' ? 501 : 500, `${code}: ${message}`),
  defaults: () => [['Content-Type', 'application/x-default']],
};
const fakeMocking: ProtocolMocking = {
  open: () => Promise.resolve(fakeContract),
  generate: () => Promise.resolve({ operations: [] }),
};
const registry = createProtocolRegistry([{ ...restProtocol, mock: fakeMocking }, grpcProtocol]);

function mock(over: Partial<MockDef> = {}): MockDef {
  return createMock(
    'M',
    { containerId: 'A1' },
    {
      id: 'M1',
      path: '/m',
      operations: [
        createMockOperation('Op', 'op', {
          id: 'O1',
          responses: [
            createMockResponse('One', {
              id: 'R1',
              status: 201,
              headers: [
                { name: 'Set-Cookie', value: 'a=1' },
                { name: 'Set-Cookie', value: 'b=2' },
              ],
              body: 'text',
              bodyText: 'first',
            }),
            createMockResponse('Two', { id: 'R2', order: 1, body: 'json', bodyText: '{"n":2}', delayMs: 150 }),
          ],
        }),
        createMockOperation('Gone', 'missing-from-contract', { id: 'O2' }),
      ],
      ...over,
    },
  );
}

function project(m: MockDef = mock()): Project {
  return {
    ...createProject('P', { id: 'P1' }),
    apis: [createApi('Api', { id: 'A1' })],
    grpcApis: [createGrpcApi('Grpc', { id: 'G1' })],
    mocks: [m],
  };
}

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function send(
  running: RunningMock,
  path: string,
  options: { method?: string; host?: string; body?: string | Buffer; agent?: boolean } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: running.port,
        path,
        method: options.method ?? 'POST',
        headers: { Host: options.host ?? `localhost:${String(running.port)}`, Authorization: 'Bearer secret-token' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

const running: RunningMock[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((m) => m.stop()));
});

async function start(m: MockDef = mock(), events: MockExchangeEvent[] = [], port = 0): Promise<RunningMock> {
  const started = await startMock({
    project: project(m),
    root: '/nowhere',
    mockId: m.id,
    registry,
    port,
    onExchange: (e) => events.push(e),
  });
  running.push(started);
  return started;
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return isWirebenchError(error) ? error.code : String(error);
  }
}

describe('startMock', () => {
  it('answers with the stub: status, its own headers, the protocol default, the body', async () => {
    const m = await start();
    expect(m.url).toBe(`http://127.0.0.1:${String(m.port)}/m`);
    const reply = await send(m, '/m/op');
    expect(reply.status).toBe(201);
    expect(reply.body).toBe('first');
    expect(reply.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(reply.headers['content-type']).toBe('application/x-default');
    expect(reply.headers['content-length']).toBe('5');
  });

  it('warns about an operation the contract does not have', async () => {
    const m = await start();
    expect(m.warnings.map((w) => [w.code, w.operationId])).toEqual([['mock-operation-unknown', 'O2']]);
  });

  it('holds a delayed stub for its delay, and reset() restarts the sequence', async () => {
    const m = await start();
    await send(m, '/m/op');
    const started = Date.now();
    const second = await send(m, '/m/op');
    expect(second.body).toBe('{"n":2}');
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    m.reset();
    expect((await send(m, '/m/op')).body).toBe('first');
  });

  it('serves a definition, a refusal, a missing stub, and a path outside the mock', async () => {
    const m = await start();
    expect((await send(m, '/m?wsdl', { method: 'GET' })).body).toBe('definition');
    expect((await send(m, '/m/refuse')).status).toBe(400);
    expect((await send(m, '/m/empty')).status).toBe(501);
    expect((await send(m, '/elsewhere')).status).toBe(500);
  });

  it('refuses a request not addressed to a loopback name (DNS rebinding)', async () => {
    const events: MockExchangeEvent[] = [];
    const m = await start(mock(), events);
    expect((await send(m, '/m/op', { host: 'evil.example:80' })).status).toBe(421);
    expect((await send(m, '/m/op', { host: `127.0.0.1:${String(m.port)}` })).status).toBe(201);
    expect(events[0]?.error?.code).toBe('mock-host-refused');
  });

  it('refuses a body over the cap with 413', async () => {
    const m = await start();
    const reply = await send(m, '/m/op', { body: Buffer.alloc(MOCK_REQUEST_BODY_BYTES + 1, 'a') });
    expect(reply.status).toBe(413);
  });

  it('logs every exchange with credentials masked and bodies cut short', async () => {
    const events: MockExchangeEvent[] = [];
    const m = await start(mock(), events);
    await send(m, '/m/op?token=abc&x=1', { body: 'x'.repeat(70 * 1024) });
    const event = events[0];
    expect(event).toMatchObject({
      seq: 1,
      method: 'POST',
      operation: 'op',
      responseId: 'R1',
      responseName: 'One',
      status: 201,
    });
    expect(event?.url).not.toContain('abc');
    expect(JSON.stringify(event?.request.headers)).not.toContain('secret-token');
    expect(JSON.stringify(event?.response.headers)).not.toContain('a=1');
    expect(event?.request.truncated).toBe(true);
    expect(event?.request.body.length).toBe(64 * 1024);
  });

  it('stop() drops a pending delayed reply and closes keep-alive connections', async () => {
    const m = await start();
    await send(m, '/m/op');
    const pending = send(m, '/m/op').catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await m.stop();
    expect(await pending).toBeInstanceOf(Error);
  });

  it('refuses a port in use, an unknown mock, a missing container and a gRPC container', async () => {
    const first = await start();
    expect(await codeOf(start(mock(), [], first.port))).toBe('mock-port-in-use');
    expect(await codeOf(startMock({ project: project(), root: '/', mockId: 'nope', registry }))).toBe('mock-not-found');
    const orphan = { ...mock(), source: { containerId: 'X' } };
    expect(await codeOf(startMock({ project: project(orphan), root: '/', mockId: 'M1', registry }))).toBe(
      'mock-container-missing',
    );
    const grpc = { ...mock(), source: { containerId: 'G1' } };
    expect(await codeOf(startMock({ project: project(grpc), root: '/', mockId: 'M1', registry }))).toBe(
      'mock-protocol-unsupported',
    );
  });

  it('renders a templated response, and refuses one whose header would carry a line break', async () => {
    const templated = mock({
      operations: [
        createMockOperation('Op', 'op', {
          id: 'O1',
          responses: [
            createMockResponse('Echo', {
              id: 'R1',
              headers: [{ name: 'X-Order', value: '{{id}}' }],
              body: 'xml',
              bodyText: '<id>{{id}}</id>',
              values: { id: { from: 'query', name: 'id' } },
            }),
          ],
        }),
      ],
    });
    const events: MockExchangeEvent[] = [];
    const m = await start(templated, events);
    const reply = await send(m, '/m/op?id=a%3Cb');
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('<id>a&lt;b</id>');
    expect(reply.headers['x-order']).toBe('a<b');

    const refused = await send(m, '/m/op?id=a%0D%0AX-Injected%3A%201');
    expect(refused.status).toBe(500);
    expect(refused.headers['x-injected']).toBeUndefined();
    expect(events.at(-1)?.error?.code).toBe('mock-template-refused');
  });
});
