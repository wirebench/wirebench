import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Assertion } from '../../../src/assert/model.js';
import { importDefinition } from '../../../src/import.js';
import { DEFAULT_PROJECT_SETTINGS, DEFAULT_REQUEST_PROPERTIES, FORMAT_VERSION } from '../../../src/project/model.js';
import type { Interface, Project, SoapRequestDef } from '../../../src/project/model.js';
import { definitionCacheDir } from '../../../src/project/paths.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import type { RestRequestDef } from '../../../src/rest/model.js';
import type { RunContext } from '../../../src/run/prepare.js';
import { runRequests } from '../../../src/run/run.js';
import type { RequestResult } from '../../../src/run/run.js';
import { selectRequests } from '../../../src/run/select.js';
import { normalizeWsa } from '../../../src/wsa/model.js';
import { startTestRestServer, startTestSoapServer } from '../../helpers/index.js';
import type { TestRestServer, TestSoapServer } from '../../helpers/index.js';

const ENVELOPE = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body><w:Echo xmlns:w="urn:wb:wsa"><w:text>hi</w:text></w:Echo></soapenv:Body></soapenv:Envelope>`;

const OK_SOAP: Assertion[] = [{ type: 'soap-fault', expect: 'none' }];
const OK_REST: Assertion[] = [{ type: 'status', equals: 200 }];

let soap: TestSoapServer;
let rest: TestRestServer;
let dir: string;

beforeAll(async () => {
  soap = await startTestSoapServer({ fixture: 'ws-addressing' });
  rest = await startTestRestServer();
  dir = mkdtempSync(join(tmpdir(), 'wb-run-'));
});

afterAll(async () => {
  await soap.close();
  await rest.close();
  rmSync(dir, { recursive: true, force: true });
});

function soapRequest(
  name: string,
  order: number,
  path: string,
  assertions: readonly Assertion[],
  extra: Partial<SoapRequestDef> = {},
): SoapRequestDef {
  return {
    kind: 'soap',
    id: `soap-${name}`,
    name,
    slug: name,
    order,
    soapVersion: '1.1',
    soapAction: 'urn:wb:wsa:Echo',
    headers: [],
    attachments: [],
    properties: DEFAULT_REQUEST_PROPERTIES,
    assertions,
    envelopeXml: ENVELOPE,
    endpointUrl: path.startsWith('http') ? path : `${soap.url}${path}`,
    ...extra,
  };
}

function restRequest(name: string, order: number, path: string, assertions: readonly Assertion[]): RestRequestDef {
  return { ...createRestRequest(name, { id: `rest-${name}`, order, url: `${rest.url}${path}` }), assertions };
}

function makeProject(
  soapRequests: readonly SoapRequestDef[],
  restRequests: readonly RestRequestDef[] = [],
  iface: Partial<Interface> = {},
): Project {
  return {
    formatVersion: FORMAT_VERSION,
    id: 'proj-run',
    name: 'Run project',
    settings: DEFAULT_PROJECT_SETTINGS,
    properties: {},
    disabledProperties: [],
    interfaces: [
      {
        kind: 'soap',
        id: 'iface-wsa',
        name: 'Wsa',
        slug: 'Wsa',
        order: 0,
        definitionUrl: soap.wsdlUrl,
        cacheDefinition: false,
        endpoints: [],
        wsa: normalizeWsa({ enabled: false, version: '2005/08' }),
        operations: [
          { name: 'Echo', bindingName: '{urn:wb:wsa}WsaPolicyBinding', slug: 'echo', order: 0, requests: soapRequests },
        ],
        ...iface,
      },
    ],
    apis: [{ ...createApi('Api', { id: 'api-1', slug: 'api', order: 1, baseUrl: '' }), requests: [...restRequests] }],
    grpcApis: [],
    wsApis: [],
    environments: [],
    wss: { outgoing: [], incoming: [], keystores: [] },
  };
}

function contextFor(project: Project, extra: Partial<RunContext> = {}): RunContext {
  return { project, projectDir: dir, overrides: {}, getSecret: () => Promise.resolve(undefined), ...extra };
}

const all = (project: Project) => selectRequests(project, []).selected;

async function deadUrl(): Promise<string> {
  const server = await startTestSoapServer();
  await server.close();
  return `${server.url}/soap`;
}

describe('runRequests', () => {
  it('reports every request passed when every assertion holds', async () => {
    const project = makeProject(
      [soapRequest('a', 0, '/soap', OK_SOAP)],
      [restRequest('b', 0, '/echo', OK_REST), restRequest('c', 1, '/status/200', OK_REST)],
    );
    const result = await runRequests(all(project), contextFor(project));
    expect(result.summary).toMatchObject({ total: 3, passed: 3, failed: 0, errored: 0, skipped: 0 });
    expect(result.requests.every((r) => r.exchange === undefined)).toBe(true);
  });

  it('fails a request whose response faults under soap-fault: none, keeping its exchange', async () => {
    const project = makeProject([soapRequest('f', 0, '/fault', OK_SOAP)]);
    const [only] = (await runRequests(all(project), contextFor(project))).requests;
    expect(only?.outcome).toBe('failed');
    expect(only?.status).toBe(500);
    expect(only?.exchange?.response).toContain('Simulated fault');
    expect(only?.exchange?.request).toContain('<w:Echo');
  });

  it('errors a request whose endpoint is unreachable and still runs the next', async () => {
    const project = makeProject([
      soapRequest('dead', 0, await deadUrl(), OK_SOAP),
      soapRequest('alive', 1, '/soap', OK_SOAP),
    ]);
    const result = await runRequests(all(project), contextFor(project));
    expect(result.requests[0]?.outcome).toBe('errored');
    expect(result.requests[0]?.error?.code).toBeDefined();
    expect(result.requests[0]?.error?.code).not.toBe('internal-error');
    expect(result.requests[1]?.outcome).toBe('passed');
  });

  it('skips, and never sends, everything after the first failure under bail', async () => {
    const project = makeProject([
      soapRequest('f', 0, '/fault', OK_SOAP),
      soapRequest('s1', 1, '/soap', OK_SOAP),
      soapRequest('s2', 2, '/soap', OK_SOAP),
    ]);
    const before = soap.requests.length;
    const result = await runRequests(all(project), contextFor(project), { bail: true });
    expect(result.requests.map((r) => r.outcome)).toEqual(['failed', 'skipped', 'skipped']);
    expect(soap.requests.length - before).toBe(1);
    expect(result.summary).toMatchObject({ total: 3, failed: 1, skipped: 2 });
  });

  it('adds the default SLA to a request with none, and not to one that declares its own', async () => {
    const project = makeProject([
      soapRequest('none', 0, '/soap', OK_SOAP),
      soapRequest('own', 1, '/soap', [...OK_SOAP, { type: 'sla', maxMs: 60_000 }]),
    ]);
    const result = await runRequests(all(project), contextFor(project), { defaultSlaMs: 30_000 });
    const slas = (r: RequestResult | undefined) => r?.assertions.filter((a) => a.type === 'sla') ?? [];
    expect(slas(result.requests[0])).toHaveLength(1);
    expect(slas(result.requests[0])[0]?.label).toContain('30000');
    expect(slas(result.requests[1])).toHaveLength(1);
    expect(slas(result.requests[1])[0]?.label).toContain('60000');
  });

  it('errors an unasserted request under requireAssertions without sending it', async () => {
    const project = makeProject([soapRequest('bare', 0, '/soap', [])]);
    const before = soap.requests.length;
    const [only] = (await runRequests(all(project), contextFor(project), { requireAssertions: true })).requests;
    expect(only?.outcome).toBe('errored');
    expect(only?.error?.code).toBe('assertions-required');
    expect(only?.unasserted).toBe(true);
    expect(soap.requests.length).toBe(before);
  });

  it('skips everything when the signal is already aborted', async () => {
    const project = makeProject([soapRequest('a', 0, '/soap', OK_SOAP)], [restRequest('b', 0, '/echo', OK_REST)]);
    const controller = new AbortController();
    controller.abort();
    const result = await runRequests(all(project), contextFor(project, { signal: controller.signal }));
    expect(result.summary).toMatchObject({ total: 2, skipped: 2, passed: 0 });
  });

  it('calls onRequestDone once per request, in order', async () => {
    const project = makeProject(
      [soapRequest('a', 0, '/soap', OK_SOAP), soapRequest('b', 1, '/fault', OK_SOAP)],
      [restRequest('c', 0, '/echo', OK_REST)],
    );
    const seen: string[] = [];
    const result = await runRequests(all(project), contextFor(project), {
      onRequestDone: (r) => seen.push(r.name),
    });
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(result.requests.map((r) => r.name)).toEqual(seen);
  });

  describe('with the definition cached in the project', () => {
    beforeAll(async () => {
      await importDefinition(
        { kind: 'url', url: soap.wsdlUrl },
        { cache: { dir: definitionCacheDir(dir, 'Wsa'), mode: 'refresh' } },
      );
    });

    it("sends the WSDL's default wsa:Action when neither SOAPAction nor an explicit Action is set", async () => {
      const request: SoapRequestDef = {
        ...soapRequest('wsa', 0, '/soap', OK_SOAP, {
          wsa: normalizeWsa({ enabled: true, version: '2005/08' }),
        }),
      };
      delete (request as { soapAction?: string }).soapAction;
      const project = makeProject([request], [], { cacheDefinition: true });
      const [only] = (await runRequests(all(project), contextFor(project))).requests;
      expect(only?.outcome).toBe('passed');
      expect(soap.requests.at(-1)?.body.toString('utf-8')).toContain('urn:wb:wsa:EchoAction');
    });

    it('evaluates a schema assertion against the cached contract', async () => {
      const project = makeProject([soapRequest('schema', 0, '/soap', [{ type: 'schema' }])], [], {
        cacheDefinition: true,
      });
      const [only] = (await runRequests(all(project), contextFor(project))).requests;
      expect(only?.assertions[0]?.outcome).not.toBe('errored');
    });

    it('treats an interface that does not cache its definition as having no contract', async () => {
      const project = makeProject([soapRequest('schema', 0, '/soap', [{ type: 'schema' }])]);
      const [only] = (await runRequests(all(project), contextFor(project))).requests;
      expect(only?.assertions[0]?.outcome).toBe('errored');
      expect(only?.assertions[0]?.message).toContain('not cached');
    });
  });
});
