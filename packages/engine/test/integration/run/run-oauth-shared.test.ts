/**
 * `runRequests` over one REST request and one gRPC request sharing the same OAuth2
 * client-credentials configuration: the run must fetch exactly one token for both, the same way
 * two gRPC calls behind one configuration already share a token (see run-grpc.test.ts).
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
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import type { RestRequestDef } from '../../../src/rest/model.js';
import type { RunContext } from '../../../src/run/prepare.js';
import { runRequests } from '../../../src/run/run.js';
import { selectRequests } from '../../../src/run/select.js';
import { readProtoFixture } from '../../helpers/proto-fixtures.js';
import { startTestGrpcServer } from '../../helpers/test-grpc-server.js';
import type { TestGrpcServer } from '../../helpers/test-grpc-server.js';
import { startTestRestServer } from '../../helpers/test-rest-server.js';
import type { TestRestServer } from '../../helpers/test-rest-server.js';

const SERVICE = 'wirebench.greet.Greeter';

let grpc: TestGrpcServer;
let rest: TestRestServer;
let dir: string;

beforeAll(async () => {
  grpc = await startTestGrpcServer();
  rest = await startTestRestServer();
  dir = mkdtempSync(join(tmpdir(), 'wb-run-oauth-shared-'));
  await writeProtoDefinitionCache(readProtoFixture('greeter'), apiDefinitionDir(dir, 'greeter'), {
    source: 'greeter.proto',
    roots: ['greeter.proto'],
  });
});

afterAll(async () => {
  await grpc.close();
  await rest.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeProject(auth: AuthConfig): Project {
  const grpcRequest: GrpcRequestDef = {
    ...createGrpcRequest('hello', { id: 'g-hello', order: 0, service: SERVICE, method: 'SayHello', message: '{}' }),
    assertions: [{ type: 'status', equals: 0 }] satisfies Assertion[],
  };
  const grpcApi: GrpcApi = createGrpcApi('Greeter', {
    id: 'api-greeter',
    slug: 'greeter',
    target: grpc.target,
    tls: false,
    auth,
    requests: [grpcRequest],
  });
  const restRequest: RestRequestDef = {
    ...createRestRequest('echo', { id: 'rest-echo', order: 0, url: `${rest.url}/echo` }),
    assertions: [{ type: 'status', equals: 200 }] satisfies Assertion[],
  };
  return {
    formatVersion: FORMAT_VERSION,
    id: 'proj-oauth-shared',
    name: 'Shared OAuth2 project',
    settings: DEFAULT_PROJECT_SETTINGS,
    properties: {},
    disabledProperties: [],
    interfaces: [],
    apis: [
      { ...createApi('Api', { id: 'api-rest', slug: 'api', order: 1, baseUrl: '', auth }), requests: [restRequest] },
    ],
    grpcApis: [grpcApi],
    wsApis: [],
    environments: [],
    wss: { outgoing: [], incoming: [], keystores: [] },
  };
}

function contextFor(project: Project, extra: Partial<RunContext> = {}): RunContext {
  return { project, projectDir: dir, overrides: {}, getSecret: () => Promise.resolve(undefined), ...extra };
}

const all = (project: Project) => selectRequests(project, []).selected;

describe('runRequests — REST and gRPC sharing one OAuth2 configuration', () => {
  it('fetches exactly one client-credentials token for both protocols', async () => {
    const auth: AuthConfig = {
      type: 'oauth2',
      grant: 'client-credentials',
      tokenUrl: 'https://auth.test/token',
      clientId: 'client',
      scopes: ['greet'],
      clientAuth: 'basic',
      pkce: false,
    };
    const project = makeProject(auth);
    const fetched: HttpRequest[] = [];
    const result = await runRequests(
      all(project),
      contextFor(project, {
        fetchToken: (request) => {
          fetched.push(request);
          const body = new TextEncoder().encode(
            JSON.stringify({ access_token: 'shared-token', token_type: 'Bearer', expires_in: 3600 }),
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
      }),
    );
    expect(result.summary).toMatchObject({ total: 2, passed: 2 });
    expect(fetched).toHaveLength(1);
  });
});
