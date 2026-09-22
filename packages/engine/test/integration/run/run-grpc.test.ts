/**
 * `runRequests` over unary gRPC calls against the in-process gRPC server: the schema read from the
 * API's definition cache, the status code and decoded message under assertion, the deadline, and
 * OAuth2 client credentials fetched once per run for every call behind the same configuration.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Assertion } from '../../../src/assert/model.js';
import { writeProtoDefinitionCache } from '../../../src/grpc/cache.js';
import { createGrpcApi, createGrpcRequest } from '../../../src/grpc/model.js';
import type { GrpcApi, GrpcRequestDef } from '../../../src/grpc/model.js';
import type { HttpExchange, HttpRequest } from '../../../src/http/types.js';
import { DEFAULT_PROJECT_SETTINGS, FORMAT_VERSION } from '../../../src/project/model.js';
import type { AuthConfig, Project } from '../../../src/project/model.js';
import { apiDefinitionDir } from '../../../src/project/paths.js';
import type { RunContext } from '../../../src/run/prepare.js';
import { runRequests } from '../../../src/run/run.js';
import { selectRequests } from '../../../src/run/select.js';
import { readProtoFixture } from '../../helpers/proto-fixtures.js';
import { startTestGrpcServer } from '../../helpers/test-grpc-server.js';
import type { TestGrpcServer } from '../../helpers/test-grpc-server.js';

const SERVICE = 'wirebench.greet.Greeter';

let server: TestGrpcServer;
let dir: string;

beforeAll(async () => {
  server = await startTestGrpcServer();
  dir = mkdtempSync(join(tmpdir(), 'wb-run-grpc-'));
  await writeProtoDefinitionCache(readProtoFixture('greeter'), apiDefinitionDir(dir, 'greeter'), {
    source: 'greeter.proto',
    roots: ['greeter.proto'],
  });
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(
  name: string,
  order: number,
  method: string,
  message: object,
  assertions: readonly Assertion[],
): GrpcRequestDef {
  return {
    ...createGrpcRequest(name, { id: `g-${name}`, order, service: SERVICE, method, message: JSON.stringify(message) }),
    assertions,
  };
}

function makeProject(requests: readonly GrpcRequestDef[], extra: { slug?: string; auth?: AuthConfig } = {}): Project {
  const api: GrpcApi = createGrpcApi('Greeter', {
    id: 'api-greeter',
    slug: extra.slug ?? 'greeter',
    target: server.target,
    tls: false,
    ...(extra.auth !== undefined ? { auth: extra.auth } : {}),
    requests: [...requests],
  });
  return {
    formatVersion: FORMAT_VERSION,
    id: 'proj-grpc',
    name: 'gRPC project',
    settings: DEFAULT_PROJECT_SETTINGS,
    properties: {},
    disabledProperties: [],
    interfaces: [],
    apis: [],
    grpcApis: [api],
    wsApis: [],
    environments: [],
    wss: { outgoing: [], incoming: [], keystores: [] },
  };
}

function contextFor(project: Project, extra: Partial<RunContext> = {}): RunContext {
  return { project, projectDir: dir, overrides: {}, getSecret: () => Promise.resolve(undefined), ...extra };
}

const all = (project: Project) => selectRequests(project, []).selected;

describe('runRequests — gRPC', () => {
  it('passes a unary call whose status, message and duration hold', async () => {
    const project = makeProject([
      call('hello', 0, 'SayHello', { name: 'Ada' }, [
        { type: 'status', equals: 'OK' },
        { type: 'status', equals: 0 },
        { type: 'match', language: 'jsonpath', expression: '$.message', equals: 'Hello, Ada' },
        { type: 'sla', maxMs: 10_000 },
      ]),
    ]);
    const [only] = (await runRequests(all(project), contextFor(project))).requests;
    expect(only).toMatchObject({ protocol: 'grpc', outcome: 'passed', status: 0, path: 'Greeter/hello' });
    expect(only?.assertions.map((a) => a.outcome)).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect(only?.exchange).toBeUndefined();
  });

  it('fails on the gRPC status code and on a JSONPath mismatch, keeping the exchange', async () => {
    const project = makeProject([
      call('fail', 0, 'Fail', { code: 5, message: 'no such greeting' }, [{ type: 'status', equals: 'OK' }]),
      call('wrong', 1, 'SayHello', { name: 'Ada' }, [
        { type: 'match', language: 'jsonpath', expression: '$.message', equals: 'Hello, Bob' },
      ]),
    ]);
    const [fail, wrong] = (await runRequests(all(project), contextFor(project))).requests;
    expect(fail).toMatchObject({ protocol: 'grpc', outcome: 'failed', status: 5 });
    expect(fail?.assertions[0]).toMatchObject({ outcome: 'failed' });
    expect(fail?.exchange?.request).toContain('/wirebench.greet.Greeter/Fail');
    expect(fail?.exchange?.response).toContain('grpc-status');
    expect(wrong).toMatchObject({ outcome: 'failed', status: 0 });
    expect(wrong?.assertions[0]).toMatchObject({ outcome: 'failed', actual: 'Hello, Ada' });
  });

  it('errors every call of an API with no cached definition, and sends none', async () => {
    const before = server.calls.length;
    const project = makeProject(
      [
        call('a', 0, 'SayHello', { name: 'Ada' }, [{ type: 'status', equals: 0 }]),
        call('b', 1, 'SayHello', { name: 'Bob' }, [{ type: 'status', equals: 0 }]),
      ],
      { slug: 'uncached' },
    );
    const result = await runRequests(all(project), contextFor(project));
    expect(result.requests.map((r) => r.error?.code)).toEqual(['grpc-definition-missing', 'grpc-definition-missing']);
    expect(result.requests[0]?.error?.details).toEqual({ api: 'Greeter' });
    expect(server.calls.length).toBe(before);
  });

  it('holds a call to --timeout rather than its own deadline', async () => {
    const project = makeProject([
      {
        ...call('slow', 0, 'Slow', { delay_ms: 2000 }, [{ type: 'status', equals: 0 }]),
        settings: { timeoutMs: 30_000 },
      },
    ]);
    const started = performance.now();
    const [only] = (await runRequests(all(project), contextFor(project, { timeoutMs: 100 }))).requests;
    expect(performance.now() - started).toBeLessThan(1500);
    expect(only).toMatchObject({ outcome: 'failed', status: 4 });
    expect(only?.assertions[0]).toMatchObject({ actual: 'DEADLINE_EXCEEDED' });
    expect(only?.exchange?.request).toContain('grpc-timeout: 100m');
  });

  it('fetches one client-credentials token for two calls behind the same configuration, and sends it', async () => {
    const auth: AuthConfig = {
      type: 'oauth2',
      grant: 'client-credentials',
      tokenUrl: 'https://auth.test/token',
      clientId: 'client',
      scopes: ['greet'],
      clientAuth: 'basic',
      pkce: false,
    };
    const project = makeProject(
      [
        call('one', 0, 'SayHello', { name: 'Ada' }, [{ type: 'status', equals: 0 }]),
        call('two', 1, 'SayHello', { name: 'Bob' }, [{ type: 'status', equals: 0 }]),
      ],
      { auth },
    );
    const fetched: HttpRequest[] = [];
    const seen: string[] = [];
    const before = server.calls.length;
    const result = await runRequests(
      all(project),
      contextFor(project, {
        fetchToken: (request) => {
          fetched.push(request);
          const body = new TextEncoder().encode(
            JSON.stringify({ access_token: 'grpc-token', token_type: 'Bearer', expires_in: 3600 }),
          );
          return Promise.resolve({
            request: { url: request.url, method: 'POST', headers: {} },
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/json' },
            rawHeaders: [],
            body,
            rawBody: body,
          } as unknown as HttpExchange);
        },
        onSecretValue: (value) => seen.push(value),
      }),
    );
    expect(result.summary).toMatchObject({ total: 2, passed: 2 });
    expect(fetched).toHaveLength(1);
    expect(seen).toEqual(['grpc-token']);
    const calls = server.calls.slice(before);
    expect(calls.map((c) => c.headers['authorization'])).toEqual(['Bearer grpc-token', 'Bearer grpc-token']);
  });
});
