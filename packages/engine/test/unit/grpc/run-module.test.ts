/** gRPC's run facet on its own: unary calls only, why a request cannot run, its needs, one send. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeProtoDefinitionCache } from '../../../src/grpc/cache.js';
import { createGrpcApi, createGrpcFolder, createGrpcRequest } from '../../../src/grpc/model.js';
import { grpcProtocol } from '../../../src/grpc/module.js';
import { grpcRun } from '../../../src/grpc/run.js';
import { createProject } from '../../../src/project/model.js';
import type { RunScope } from '../../../src/protocol/module.js';
import type { Project } from '../../../src/project/model.js';
import { apiDefinitionDir } from '../../../src/project/paths.js';
import type { RunContext } from '../../../src/run/context.js';
import { createRunScope } from '../../../src/run/scope.js';
import { selectRequests } from '../../../src/run/select.js';
import { readProtoFixture } from '../../helpers/proto-fixtures.js';

const { events } = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock('../../../src/grpc/call.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/grpc/call.js')>()),
  callGrpc: (input: { readonly target: string; readonly messageText: string }) => {
    events.push(`send ${input.target} ${input.messageText}`);
    return Promise.resolve({
      exchange: {
        status: 0,
        statusName: 'OK',
        headers: {},
        trailers: {},
        rawRequest: new Uint8Array(),
        rawResponse: new Uint8Array(),
        durationMs: 1,
      },
      methodKind: 'unary',
      requestType: '',
      responseType: '',
      requestMessages: [],
      responseMessages: [{ json: { message: 'Hello' } }],
    });
  },
}));

const SERVICE = 'wirebench.greet.Greeter';

function api(name: string, slug: string, order: number) {
  return createGrpcApi(name, {
    id: `api-${slug}`,
    slug,
    order,
    target: 'localhost:50051',
    tls: false,
    auth: { type: 'bearer', tokenRef: 'ref-token' },
    requests: [
      createGrpcRequest('Hello', {
        id: `${slug}-hello`,
        slug: 'hello',
        order: 1,
        service: SERVICE,
        method: 'SayHello',
        message: '{"name":"${secret:tenant}"}',
      }),
      createGrpcRequest('Chat', { id: `${slug}-chat`, order: 0, methodKind: 'bidi-streaming' }),
      { ...createGrpcRequest('Gone', { id: `${slug}-gone`, order: 2 }), orphaned: true },
      {
        ...createGrpcRequest('Both', { id: `${slug}-both`, order: 3, methodKind: 'server-streaming' }),
        orphaned: true,
      },
    ],
    folders: [
      createGrpcFolder('Admin', {
        id: `${slug}-admin`,
        slug: 'admin',
        order: 0,
        requests: [createGrpcRequest('Fail', { id: `${slug}-fail`, slug: 'fail', service: SERVICE, method: 'Fail' })],
      }),
    ],
  });
}

const project: Project = {
  ...createProject('gRPC module', { id: 'proj-grpc' }),
  grpcApis: [api('Greeter', 'greeter', 1), api('Uncached', 'uncached', 0)],
};

let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wb-grpc-module-'));
  await writeProtoDefinitionCache(readProtoFixture('greeter'), apiDefinitionDir(dir, 'greeter'), {
    source: 'greeter.proto',
    roots: ['greeter.proto'],
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  events.length = 0;
});

function context(): RunContext {
  return {
    project,
    projectDir: dir,
    overrides: {},
    host: {
      getSecret: (ref) => {
        events.push(`secret ${ref}`);
        return Promise.resolve('abc123def456ghi789');
      },
    },
  };
}

const itemAt = (path: string) =>
  grpcRun
    .groups(project)
    .flatMap((group) => group.candidates)
    .find((candidate) => candidate.item.path === path)?.item;

describe('grpcRun.groups', () => {
  it('offers one group per API with its unary, non-orphaned requests in explorer order', () => {
    expect(grpcRun.groups(project).map((group) => [group.order, group.name, group.explicitOnly])).toEqual([
      [1, 'Greeter', undefined],
      [0, 'Uncached', undefined],
    ]);
    const [greeter] = grpcRun.groups(project);
    expect(greeter?.candidates.map((candidate) => [candidate.item.path, candidate.diskPath])).toEqual([
      ['Greeter/Admin/Fail', 'apis/greeter/requests/admin/fail'],
      ['Greeter/Hello', 'apis/greeter/requests/hello'],
    ]);
  });

  it('offers exactly what a run selects of gRPC', () => {
    expect(selectRequests(project, ['Greeter']).selected).toEqual(
      grpcRun.groups(project)[0]?.candidates.map((candidate) => candidate.item),
    );
  });
});

describe('grpcRun.whyNotRunnable', () => {
  it('names streaming before orphaned, and says nothing for a unary call', () => {
    const streaming = 'A streaming gRPC call cannot be a sequence step; only unary calls can';
    expect(grpcRun.whyNotRunnable(project, 'greeter-chat')).toBe(streaming);
    expect(grpcRun.whyNotRunnable(project, 'greeter-both')).toBe(streaming);
    expect(grpcRun.whyNotRunnable(project, 'greeter-gone')).toBe('The request is no longer in its contract (orphaned)');
    expect(grpcRun.whyNotRunnable(project, 'greeter-fail')).toBeUndefined();
    expect(grpcRun.whyNotRunnable(project, 'nowhere')).toBeUndefined();
  });
});

describe('grpcRun.secretNeeds', () => {
  it('lists the effective auth through the folders to the API', () => {
    const fail = itemAt('Greeter/Admin/Fail');
    expect(fail && grpcRun.secretNeeds(fail, project)).toEqual([{ ref: 'ref-token', purpose: 'bearer token' }]);
  });
});

const sendGrpc = (item: Parameters<typeof grpcRun.open>[0], scope: RunScope) =>
  grpcRun.open(item, scope, scope.context.host, { scope, interactive: false }).result;

describe('grpcRun.open', () => {
  it('loads the schema, resolves, connects, calls once, and reports a gRPC subject with the target as origin', async () => {
    const hello = itemAt('Greeter/Hello');
    const sent = hello && (await sendGrpc(hello, createRunScope(context())));
    expect(events).toEqual([
      'secret secret:tenant',
      'secret ref-token',
      'send localhost:50051 {"name":"abc123def456ghi789"}',
    ]);
    expect(sent?.subject).toMatchObject({ protocol: 'grpc', status: 0, bodyText: '{"message":"Hello"}' });
    // The call whole, for a host that records more than a report does.
    expect(sent?.exchange).toMatchObject({ kind: 'grpc', grpc: { exchange: { status: 0 } } });
    expect(sent?.origin).toBe('localhost:50051');
  });

  it('refuses a call whose API has no cached definition before it asks for a credential, and remembers', async () => {
    const hello = itemAt('Uncached/Hello');
    const scope = createRunScope(context());
    await expect(hello && sendGrpc(hello, scope)).rejects.toMatchObject({ code: 'grpc-definition-missing' });
    await expect(hello && sendGrpc(hello, scope)).rejects.toMatchObject({ code: 'grpc-definition-missing' });
    // Each send resolves its secret tokens first; the credential (ref-token) is never asked for.
    expect(events).toEqual(['secret secret:tenant', 'secret secret:tenant']);
  });

  // The app's precedence: unresolved references, then no method, then the schema.
  const uncachedWith = (patch: Partial<Project['grpcApis'][number]['requests'][number]>) => {
    const p: Project = {
      ...project,
      grpcApis: project.grpcApis.map((a) => ({
        ...a,
        requests: a.requests.map((request) => (request.name === 'Hello' ? { ...request, ...patch } : request)),
      })),
    };
    const item = grpcRun
      .groups(p)
      .flatMap((group) => group.candidates)
      .find((candidate) => candidate.item.path === 'Uncached/Hello')?.item;
    if (item === undefined) throw new Error('No Uncached/Hello');
    return sendGrpc(item, createRunScope({ ...context(), project: p }));
  };

  it('refuses a call with no method before its missing schema', async () => {
    await expect(uncachedWith({ method: '' })).rejects.toMatchObject({ code: 'grpc-method-unset' });
  });

  it('refuses an unresolved reference before a missing method or schema', async () => {
    await expect(uncachedWith({ method: '', message: '{"name":"${nope}"}' })).rejects.toMatchObject({
      code: 'grpc-unresolved-properties',
      details: { unresolved: ['${nope}'] },
    });
  });
});

describe('grpcRun.resolve', () => {
  const resolveIn = (p: Project, path: string): Promise<unknown> => {
    const item = grpcRun
      .groups(p)
      .flatMap((group) => group.candidates)
      .find((candidate) => candidate.item.path === path)?.item;
    if (item === undefined) throw new Error(`No request at ${path}`);
    const scope = createRunScope({ ...context(), project: p });
    return grpcRun.resolve(item, scope, scope.context.host);
  };

  it('returns the input and the message with its secret tokens expanded, no credentials, and nothing unresolved', async () => {
    const resolved = await resolveIn(project, 'Greeter/Hello');
    expect(resolved).toMatchObject({
      input: { target: 'localhost:50051', service: 'wirebench.greet.Greeter', method: 'SayHello' },
      messageText: '{"name":"abc123def456ghi789"}',
      unresolved: [],
    });
    expect(resolved).not.toHaveProperty('input.auth');
    // The token is asked for in connect, which resolve does not reach.
    expect(events).toEqual(['secret secret:tenant']);
  });

  it('reports a reference nothing resolves, and does not throw it', async () => {
    const withRef: Project = {
      ...project,
      grpcApis: project.grpcApis.map((api) => ({
        ...api,
        requests: api.requests.map((request) => ({ ...request, message: '{"name":"${nope}"}' })),
      })),
    };
    expect(await resolveIn(withRef, 'Greeter/Hello')).toMatchObject({ unresolved: [{ expr: '${nope}' }] });
  });
});

describe('grpcRun.scriptTypes', () => {
  it('types the messages from the schema, and leaves them untyped when the schema does not load', async () => {
    const scope = createRunScope(context());
    const typed = itemAt('Greeter/Hello');
    const untyped = itemAt('Uncached/Hello');
    expect((typed && (await grpcRun.scriptTypes(typed, scope)))?.generated).not.toContain('WbRequestMessage = unknown');
    expect((untyped && (await grpcRun.scriptTypes(untyped, scope)))?.generated).toContain('WbRequestMessage = unknown');
  });
});

describe('grpcProtocol', () => {
  it('is the grpc kind behind the grpc feature, with a run facet', () => {
    expect(grpcProtocol.kind).toBe('grpc');
    expect(grpcProtocol.feature).toEqual({ id: 'grpc', title: 'gRPC', default: true, stage: 'stable', requires: [] });
    expect(grpcProtocol.run?.groups(project)).toHaveLength(2);
  });
});
