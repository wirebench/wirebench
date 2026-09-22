/**
 * `runRequests` after a server refuses the run's OAuth2 token: a REST or SOAP `401`, or a gRPC
 * `UNAUTHENTICATED`, drops the cached token, so the next request behind the configuration fetches a
 * new one. The refused request itself is sent once and never again.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Assertion } from '../../../src/assert/model.js';
import { writeProtoDefinitionCache } from '../../../src/grpc/cache.js';
import { createGrpcApi, createGrpcRequest } from '../../../src/grpc/model.js';
import type { GrpcRequestDef } from '../../../src/grpc/model.js';
import type { HttpExchange, HttpRequest } from '../../../src/http/types.js';
import { DEFAULT_PROJECT_SETTINGS, DEFAULT_REQUEST_PROPERTIES, FORMAT_VERSION } from '../../../src/project/model.js';
import type { Interface, OAuth2Auth, Project, SoapRequestDef } from '../../../src/project/model.js';
import { apiDefinitionDir } from '../../../src/project/paths.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import type { RestRequestDef } from '../../../src/rest/model.js';
import type { RunContext } from '../../../src/run/prepare.js';
import { runRequests } from '../../../src/run/run.js';
import { selectRequests } from '../../../src/run/select.js';
import { normalizeWsa } from '../../../src/wsa/model.js';
import { readProtoFixture } from '../../helpers/proto-fixtures.js';
import { startTestGrpcServer } from '../../helpers/test-grpc-server.js';
import type { TestGrpcServer } from '../../helpers/test-grpc-server.js';
import { startTestRestServer } from '../../helpers/test-rest-server.js';
import type { TestRestServer } from '../../helpers/test-rest-server.js';

const SERVICE = 'wirebench.greet.Greeter';

const AUTH: OAuth2Auth = {
  type: 'oauth2',
  grant: 'client-credentials',
  tokenUrl: 'https://auth.test/token',
  clientId: 'client',
  scopes: ['greet'],
  clientAuth: 'basic',
  pkce: false,
};

let grpc: TestGrpcServer;
let rest: TestRestServer;
let dir: string;

beforeAll(async () => {
  grpc = await startTestGrpcServer();
  rest = await startTestRestServer();
  dir = mkdtempSync(join(tmpdir(), 'wb-run-oauth-rejected-'));
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

function baseProject(): Project {
  return {
    formatVersion: FORMAT_VERSION,
    id: 'proj-oauth-rejected',
    name: 'Rejected OAuth2 project',
    settings: DEFAULT_PROJECT_SETTINGS,
    properties: {},
    disabledProperties: [],
    interfaces: [],
    apis: [],
    grpcApis: [],
    wsApis: [],
    environments: [],
    wss: { outgoing: [], incoming: [], keystores: [] },
  };
}

function restProject(paths: readonly string[]): Project {
  const requests: RestRequestDef[] = paths.map((path, order) => ({
    ...createRestRequest(`r${String(order)}`, { id: `rest-${String(order)}`, order, url: `${rest.url}${path}` }),
    assertions: [{ type: 'status', equals: 200 }] satisfies Assertion[],
  }));
  return {
    ...baseProject(),
    apis: [{ ...createApi('Api', { id: 'api-rest', slug: 'api', order: 0, baseUrl: '', auth: AUTH }), requests }],
  };
}

/** SOAP requests posted to the REST test server's routes: its `/status/401` refuses any credential. */
function soapProject(paths: readonly string[]): Project {
  const requests: SoapRequestDef[] = paths.map((path, order) => ({
    kind: 'soap',
    id: `soap-${String(order)}`,
    name: `s${String(order)}`,
    slug: `s${String(order)}`,
    order,
    soapVersion: '1.1',
    headers: [],
    attachments: [],
    properties: DEFAULT_REQUEST_PROPERTIES,
    assertions: [{ type: 'status', equals: 200 }] satisfies Assertion[],
    envelopeXml: '<Envelope/>',
    endpointId: `ep-${String(order)}`,
    auth: AUTH,
  }));
  const iface: Interface = {
    kind: 'soap',
    id: 'iface-soap',
    name: 'Soap',
    slug: 'Soap',
    order: 0,
    definitionUrl: 'http://example.test/def.wsdl',
    cacheDefinition: false,
    endpoints: paths.map((path, order) => ({
      id: `ep-${String(order)}`,
      name: `ep${String(order)}`,
      url: `${rest.url}${path}`,
      authMode: 'override' as const,
    })),
    wsa: normalizeWsa({ enabled: false, version: '2005/08' }),
    operations: [{ name: 'Op', bindingName: '{urn:t}B', slug: 'op', order: 0, requests }],
  };
  return { ...baseProject(), interfaces: [iface] };
}

function grpcProject(calls: readonly { method: string; message: object }[]): Project {
  const requests: GrpcRequestDef[] = calls.map(({ method, message }, order) => ({
    ...createGrpcRequest(`g${String(order)}`, {
      id: `g-${String(order)}`,
      order,
      service: SERVICE,
      method,
      message: JSON.stringify(message),
    }),
    assertions: [{ type: 'status', equals: 0 }] satisfies Assertion[],
  }));
  return {
    ...baseProject(),
    grpcApis: [
      createGrpcApi('Greeter', {
        id: 'api-greeter',
        slug: 'greeter',
        target: grpc.target,
        tls: false,
        auth: AUTH,
        requests,
      }),
    ],
  };
}

/** A token endpoint that hands out `tok-1`, `tok-2`, … one per request, and counts them. */
function tokenIssuer(): { fetched: HttpRequest[]; fetchToken: RunContext['fetchToken'] } {
  const fetched: HttpRequest[] = [];
  return {
    fetched,
    fetchToken: (request) => {
      fetched.push(request);
      const body = new TextEncoder().encode(
        JSON.stringify({ access_token: `tok-${String(fetched.length)}`, token_type: 'Bearer', expires_in: 3600 }),
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
  };
}

async function run(project: Project, issuer: ReturnType<typeof tokenIssuer>) {
  const context: RunContext = {
    project,
    projectDir: dir,
    overrides: {},
    getSecret: () => Promise.resolve(undefined),
    ...(issuer.fetchToken !== undefined ? { fetchToken: issuer.fetchToken } : {}),
  };
  return runRequests(selectRequests(project, []).selected, context);
}

describe('runRequests — a refused OAuth2 token', () => {
  it('fetches a new token after a REST 401, without sending the refused request again', async () => {
    const issuer = tokenIssuer();
    const before = rest.requests.length;
    const result = await run(restProject(['/status/401', '/echo', '/echo']), issuer);
    expect(result.requests.map((r) => r.status)).toEqual([401, 200, 200]);
    expect(issuer.fetched).toHaveLength(2);
    const sent = rest.requests.slice(before);
    expect(sent.map((r) => new URL(r.url, rest.url).pathname)).toEqual(['/status/401', '/echo', '/echo']);
    expect(sent.map((r) => r.headers['authorization'])).toEqual(['Bearer tok-1', 'Bearer tok-2', 'Bearer tok-2']);
  });

  it('keeps the token after a REST 403, which refuses the caller, not the credential', async () => {
    const issuer = tokenIssuer();
    const result = await run(restProject(['/status/403', '/echo']), issuer);
    expect(result.requests.map((r) => r.status)).toEqual([403, 200]);
    expect(issuer.fetched).toHaveLength(1);
  });

  it('fetches a new token after a SOAP 401, without sending the refused request again', async () => {
    const issuer = tokenIssuer();
    const before = rest.requests.length;
    const result = await run(soapProject(['/status/401', '/echo', '/echo']), issuer);
    expect(result.requests.map((r) => r.status)).toEqual([401, 200, 200]);
    expect(issuer.fetched).toHaveLength(2);
    const sent = rest.requests.slice(before);
    expect(sent.map((r) => new URL(r.url, rest.url).pathname)).toEqual(['/status/401', '/echo', '/echo']);
    expect(sent.map((r) => r.headers['authorization'])).toEqual(['Bearer tok-1', 'Bearer tok-2', 'Bearer tok-2']);
  });

  it('fetches a new token after a gRPC UNAUTHENTICATED, without sending the refused call again', async () => {
    const issuer = tokenIssuer();
    const before = grpc.calls.length;
    const result = await run(
      grpcProject([
        { method: 'Fail', message: { code: 16, message: 'token revoked' } },
        { method: 'SayHello', message: { name: 'Ada' } },
        { method: 'SayHello', message: { name: 'Bob' } },
      ]),
      issuer,
    );
    expect(result.requests.map((r) => r.status)).toEqual([16, 0, 0]);
    expect(issuer.fetched).toHaveLength(2);
    const calls = grpc.calls.slice(before);
    expect(calls.map((c) => c.path.split('/').pop())).toEqual(['Fail', 'SayHello', 'SayHello']);
    expect(calls.map((c) => c.headers['authorization'])).toEqual(['Bearer tok-1', 'Bearer tok-2', 'Bearer tok-2']);
  });

  it('keeps the token after any other gRPC failure', async () => {
    const issuer = tokenIssuer();
    const result = await run(
      grpcProject([
        { method: 'Fail', message: { code: 7 } },
        { method: 'SayHello', message: { name: 'Ada' } },
      ]),
      issuer,
    );
    expect(result.requests.map((r) => r.status)).toEqual([7, 0]);
    expect(issuer.fetched).toHaveLength(1);
  });
});
