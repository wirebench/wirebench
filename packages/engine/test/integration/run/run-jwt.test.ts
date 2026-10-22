/**
 * `runRequests` with a client-signed JWT (#348): the token is signed from the configuration, placed
 * as a header or a query parameter, reused across requests while it is fresh, and signed anew after
 * a server refuses it. RS/ES/PS keys come from a keystore inside the project folder.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeJwt, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Assertion } from '../../../src/assert/model.js';
import { writeProtoDefinitionCache } from '../../../src/grpc/cache.js';
import { createGrpcApi, createGrpcRequest } from '../../../src/grpc/model.js';
import { toKeystoreRef } from '../../../src/project/keystores.js';
import { DEFAULT_PROJECT_SETTINGS, FORMAT_VERSION } from '../../../src/project/model.js';
import type { JwtAuth, Project } from '../../../src/project/model.js';
import { apiDefinitionDir } from '../../../src/project/paths.js';
import { createApi, createRestRequest, withRestApis } from '../../../src/rest/model.js';
import type { RunContext } from '../../../src/run/context.js';
import { runRequests } from '../../../src/run/run.js';
import { selectRequests } from '../../../src/run/select.js';
import { testHost } from '../../helpers/send-host.js';
import { readProtoFixture } from '../../helpers/proto-fixtures.js';
import { startTestGrpcServer } from '../../helpers/test-grpc-server.js';
import type { TestGrpcServer } from '../../helpers/test-grpc-server.js';
import { startTestRestServer } from '../../helpers/test-rest-server.js';
import type { TestRestServer } from '../../helpers/test-rest-server.js';
// The composition: the entry points fall back to the registry it installs (package split spec §3.3).
import '../../../src/protocols.js';

const SECRET = 'jwt-shared-secret-0123456789-abcdefghijklmnop';
const HS256: JwtAuth = {
  type: 'jwt',
  algorithm: 'HS256',
  secretRef: 'sec_jwt',
  claims: '{"iss":"${#Project#issuer}","sub":"svc"}',
  issuedAt: true,
  expiresInSeconds: 300,
  jwtId: true,
  in: 'header',
};

let rest: TestRestServer;
let grpc: TestGrpcServer;
let dir: string;
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });

beforeAll(async () => {
  rest = await startTestRestServer();
  grpc = await startTestGrpcServer();
  dir = mkdtempSync(join(tmpdir(), 'wb-run-jwt-'));
  writeFileSync(join(dir, 'signing.pem'), ec.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  await writeProtoDefinitionCache(readProtoFixture('greeter'), apiDefinitionDir(dir, 'greeter'), {
    source: 'greeter.proto',
    roots: ['greeter.proto'],
  });
});

afterAll(async () => {
  await rest.close();
  await grpc.close();
  rmSync(dir, { recursive: true, force: true });
});

function baseProject(): Project {
  return {
    formatVersion: FORMAT_VERSION,
    id: 'proj-jwt',
    name: 'JWT project',
    settings: DEFAULT_PROJECT_SETTINGS,
    properties: { issuer: 'wirebench' },
    disabledProperties: [],
    containers: {},
    sequences: [],
    mocks: [],
    environments: [],
    keystores: [toKeystoreRef({ id: 'ks-ec', name: 'Signing key', path: 'signing.pem', type: 'pem' })],
  };
}

function restProject(auth: JwtAuth, paths: readonly string[]): Project {
  const requests = paths.map((path, order) => ({
    ...createRestRequest(`r${String(order)}`, { id: `rest-${String(order)}`, order, url: `${rest.url}${path}` }),
    assertions: [{ type: 'status', equals: 200 }] satisfies Assertion[],
  }));
  return withRestApis(baseProject(), [
    { ...createApi('Api', { id: 'api-rest', slug: 'api', order: 0, baseUrl: '', auth }), requests },
  ]);
}

async function run(project: Project) {
  const reported: string[] = [];
  const context: RunContext = {
    project,
    projectDir: dir,
    overrides: {},
    host: testHost({ sec_jwt: SECRET }, { onSecretValue: (value) => reported.push(value) }),
  };
  const result = await runRequests(selectRequests(project, []).selected, context);
  return { result, reported };
}

const one = (value: string | readonly string[] | undefined): string =>
  typeof value === 'string' ? value : (value?.[0] ?? '');
const bare = (value: string | readonly string[] | undefined): string => one(value).replace(/^Bearer /u, '');

describe('runRequests — a client-signed JWT', () => {
  it('sends one signed token for every request while it is fresh, and a new one after a 401', async () => {
    const before = rest.requests.length;
    const { result, reported } = await run(restProject(HS256, ['/echo', '/status/401', '/echo', '/echo']));
    expect(result.requests.map((r) => r.status)).toEqual([200, 401, 200, 200]);
    const tokens = rest.requests.slice(before).map((r) => bare(r.headers['authorization']));
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[2]).not.toBe(tokens[1]);
    expect(tokens[3]).toBe(tokens[2]);
    const { payload } = await jwtVerify(tokens[0] ?? '', new TextEncoder().encode(SECRET));
    expect(payload).toMatchObject({ iss: 'wirebench', sub: 'svc' });
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'iss', 'jti', 'sub']);
    expect(reported).toContain(tokens[0]);
  });

  it('sends the token as a query parameter, under a custom header name, or bare', async () => {
    const before = rest.requests.length;
    await run(restProject({ ...HS256, in: 'query', name: 'jwt' }, ['/echo']));
    await run(restProject({ ...HS256, name: 'X-Auth', prefix: '' }, ['/echo']));
    const [query, header] = rest.requests.slice(before);
    const token = new URL(query?.url ?? '', rest.url).searchParams.get('jwt');
    expect(decodeJwt(token ?? '').sub).toBe('svc');
    expect(header?.headers['authorization']).toBeUndefined();
    expect(decodeJwt(one(header?.headers['x-auth'])).sub).toBe('svc');
  });

  it('signs with a key-only PEM keystore inside the project folder', async () => {
    const before = rest.requests.length;
    await run(restProject({ ...HS256, algorithm: 'ES256', keystoreRef: 'ks-ec' }, ['/echo']));
    const token = bare(rest.requests[before]?.headers['authorization']);
    await jwtVerify(token, ec.publicKey, { algorithms: ['ES256'] });
  });

  it('refuses the send, naming the problem, when no key is configured', async () => {
    const before = rest.requests.length;
    const { result } = await run(restProject({ ...HS256, algorithm: 'RS256' }, ['/echo']));
    expect(JSON.stringify(result.requests[0])).toContain('jwt-key-missing');
    expect(rest.requests.length).toBe(before);
  });

  it('puts the token in gRPC metadata', async () => {
    const before = grpc.calls.length;
    const project: Project = {
      ...baseProject(),
      containers: {
        grpc: [
          createGrpcApi('Greeter', {
            id: 'api-greeter',
            slug: 'greeter',
            target: grpc.target,
            tls: false,
            auth: HS256,
            requests: [
              createGrpcRequest('hello', {
                id: 'g-0',
                service: 'wirebench.greet.Greeter',
                method: 'SayHello',
                message: JSON.stringify({ name: 'Ada' }),
              }),
            ],
          }),
        ],
      },
    };
    const { result } = await run(project);
    expect(result.requests[0]?.status).toBe(0);
    expect(decodeJwt(bare(grpc.calls[before]?.headers['authorization'])).sub).toBe('svc');
  });
});
