/**
 * One request sends the same bytes from either host (spec §3.1): the command line lends only a secret
 * getter, the desktop also lends preferences and a token source. What reaches each protocol's test
 * server must match, a `Date` header and a multipart boundary aside.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeProtoDefinitionCache } from '../../../src/grpc/cache.js';
import { createGrpcApi, createGrpcRequest } from '../../../src/grpc/model.js';
import type { GrpcSelected } from '../../../src/grpc/run.js';
import {
  createApi,
  createInterface,
  createProject,
  createRequest,
  createRestRequest,
  DEFAULT_PREFERENCES,
  soapItemFor,
} from '../../../src/index.js';
import type { Project, SoapRequestDef } from '../../../src/index.js';
import { apiDefinitionDir } from '../../../src/project/paths.js';
import type { RunContext } from '../../../src/run/context.js';
import type { SendHost } from '../../../src/run/host.js';
import { createRunTokenSource } from '../../../src/run/oauth2-token.js';
import { openExchange } from '../../../src/run/open.js';
import { createRunScope } from '../../../src/run/scope.js';
import { selectRequests } from '../../../src/run/select.js';
import type { SelectedRequest } from '../../../src/run/select.js';
import { readProtoFixture } from '../../helpers/proto-fixtures.js';
import { testHost } from '../../helpers/send-host.js';
import { startTestGrpcServer } from '../../helpers/test-grpc-server.js';
import type { TestGrpcServer } from '../../helpers/test-grpc-server.js';
import { startTestRestServer } from '../../helpers/test-rest-server.js';
import type { TestRestServer } from '../../helpers/test-rest-server.js';
import { startTestSoapServer } from '../../helpers/test-soap-server.js';
import type { TestSoapServer } from '../../helpers/test-soap-server.js';
import { withRestApis } from '../../../src/rest/model.js';

let rest: TestRestServer;
let soap: TestSoapServer;
let grpc: TestGrpcServer;
let dir: string;

beforeAll(async () => {
  [rest, soap, grpc] = await Promise.all([startTestRestServer(), startTestSoapServer(), startTestGrpcServer()]);
  dir = mkdtempSync(join(tmpdir(), 'wb-host-parity-'));
  await writeProtoDefinitionCache(readProtoFixture('greeter'), apiDefinitionDir(dir, 'greeter'), {
    source: 'greeter.proto',
    roots: ['greeter.proto'],
  });
});

afterAll(async () => {
  await Promise.all([rest.close(), soap.close(), grpc.close()]);
  rmSync(dir, { recursive: true, force: true });
});

const secrets: Readonly<Record<string, string>> = { token: 's3cret' };
const getSecret: SendHost['getSecret'] = (ref) => Promise.resolve(secrets[ref]);

/** The command line's shape: a secret getter and nothing else (see the CLI's `cliSendHost`). */
function cliShaped(): SendHost {
  return { getSecret, proxyFor: () => Promise.resolve(undefined), onSecretValue: () => undefined };
}

/** The desktop's shape: the same getter, plus preferences and a run token source. */
function desktopShaped(): SendHost {
  const send = (): never => {
    throw new Error('no token request expected');
  };
  return {
    ...testHost(secrets),
    preferences: DEFAULT_PREFERENCES,
    tokens: createRunTokenSource({ getSecret, send }),
  };
}

const HOSTS: readonly (readonly [string, () => SendHost])[] = [
  ['command line', cliShaped],
  ['desktop', desktopShaped],
];

async function send(p: Project, item: SelectedRequest, host: SendHost): Promise<void> {
  const context: RunContext = { project: p, projectDir: dir, overrides: {}, host };
  await openExchange(item, host, { scope: createRunScope(context), interactive: false }).result;
}

/** A header map without what legitimately differs between two sends. */
function stable(headers: Readonly<Record<string, string | string[] | undefined>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'date') continue;
    out[name.toLowerCase()] = typeof value === 'string' ? value.replace(/boundary=\S+/, 'boundary=B') : value;
  }
  return out;
}

const withoutBoundary = (body: Buffer): string => body.toString('latin1').replace(/--[-\w]{8,}/g, '--B');

describe('one request, either host', () => {
  it('REST arrives the same', async () => {
    const request = createRestRequest('Echo', {
      id: 'r1',
      method: 'POST',
      url: '/echo?a=1',
      headers: [{ name: 'X-Trace', value: 'abc', enabled: true }],
      body: { kind: 'raw', language: 'json', text: '{"k":"v"}' },
    });
    const p: Project = withRestApis(
      {
        ...createProject('Parity rest', { id: 'p-rest' }),
      },
      [{ ...createApi('Api', { id: 'api-1', slug: 'api', baseUrl: rest.url }), requests: [request] }],
    );
    const item = selectRequests(p, ['Api/Echo']).selected[0]!;
    const seen: unknown[] = [];
    for (const [, make] of HOSTS) {
      rest.requests.length = 0;
      await send(p, item, make());
      expect(rest.requests).toHaveLength(1);
      const [r] = rest.requests;
      seen.push({ method: r!.method, url: r!.url, headers: stable(r!.headers), body: withoutBoundary(r!.body) });
    }
    expect(seen[1]).toEqual(seen[0]);
  });

  it('SOAP arrives the same', async () => {
    const def: SoapRequestDef = {
      ...createRequest('Get', {
        id: 'r1',
        envelopeXml: '<Envelope><Body><who>${#Project#who}</who></Body></Envelope>',
        soapVersion: '1.1',
        headers: [{ name: 'X-Trace', value: 'abc' }],
      }),
      endpointUrl: `${soap.url}/service`,
    };
    const iface = createInterface('Svc', {
      id: 'i1',
      definitionUrl: `${soap.url}/service?wsdl`,
      cacheDefinition: false,
      operations: [{ name: 'Op', bindingName: '{urn:t}B', slug: 'op', order: 0, requests: [def] }],
    });
    const p: Project = {
      ...createProject('Parity soap', { id: 'p-soap' }),
      properties: { who: 'ada' },
      containers: { soap: [iface] },
    };
    const item = soapItemFor(p, 'r1')!;
    const seen: unknown[] = [];
    for (const [, make] of HOSTS) {
      soap.requests.length = 0;
      await send(p, item, make());
      const posts = soap.requests.filter((r) => r.method === 'POST');
      expect(posts).toHaveLength(1);
      const [r] = posts;
      seen.push({ url: r!.url, headers: stable(r!.headers), body: withoutBoundary(r!.body) });
    }
    expect(seen[1]).toEqual(seen[0]);
  });

  it('a unary gRPC call arrives the same', async () => {
    const request = createGrpcRequest('SayHello', {
      id: 'g1',
      service: 'wirebench.greet.Greeter',
      method: 'SayHello',
      methodKind: 'unary',
      metadata: [{ name: 'x-trace', value: 'abc', enabled: true }],
      message: JSON.stringify({ name: 'ada' }),
    });
    const api = createGrpcApi('Greeter', {
      id: 'api-greeter',
      slug: 'greeter',
      target: grpc.target,
      tls: false,
      requests: [request],
    });
    const p: Project = { ...createProject('Parity grpc', { id: 'p-grpc' }), containers: { grpc: [api] } };
    const item: GrpcSelected = { kind: 'grpc', path: 'Greeter/SayHello', group: 'Greeter', api, chain: [], request };
    const seen: unknown[] = [];
    for (const [, make] of HOSTS) {
      grpc.calls.length = 0;
      await send(p, item, make());
      expect(grpc.calls).toHaveLength(1);
      const [c] = grpc.calls;
      seen.push({ path: c!.path, headers: stable(c!.headers), messages: c!.messages });
    }
    expect(seen[1]).toEqual(seen[0]);
  });
});
