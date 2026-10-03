import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Assertion } from '../../../src/assert/model.js';
import { importWsdl } from '../../../src/soap/import.js';
import { DEFAULT_PROJECT_SETTINGS, DEFAULT_REQUEST_PROPERTIES, FORMAT_VERSION } from '../../../src/project/model.js';
import type { Interface, Project, SoapRequestDef } from '../../../src/project/model.js';
import { definitionCacheDir } from '../../../src/project/paths.js';
import { requestFileLocation } from '../../../src/project/request-location.js';
import type { SelectedRequest } from '../../../src/protocols.js';
import { readGoldenFile } from '../../../src/snapshot/golden-file.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import type { RestRequestDef } from '../../../src/rest/model.js';
import type { RunContext } from '../../../src/run/context.js';
import { runRequests } from '../../../src/run/run.js';
import type { RequestResult } from '../../../src/run/run.js';
import { selectRequests } from '../../../src/run/select.js';
import { testHost } from '../../helpers/send-host.js';
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
    sequences: [],
    environments: [],
    wss: { outgoing: [], incoming: [], keystores: [] },
  };
}

function contextFor(project: Project, extra: Partial<RunContext> = {}): RunContext {
  return { project, projectDir: dir, overrides: {}, host: testHost(), ...extra };
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

  it('hands onSent each request that got a response, with its SOAP or REST exchange', async () => {
    const project = makeProject(
      [soapRequest('dead', 0, await deadUrl(), OK_SOAP), soapRequest('a', 1, '/soap', OK_SOAP)],
      [restRequest('b', 0, '/echo', OK_REST)],
    );
    const seen: (readonly [string, string | undefined, number | undefined])[] = [];
    await runRequests(all(project), contextFor(project), {
      onSent: (item, sent) => {
        const exchange = sent.exchange;
        const status =
          exchange === undefined
            ? undefined
            : exchange.kind === 'soap'
              ? exchange.soap.http.status
              : exchange.kind === 'rest'
                ? exchange.rest.status
                : undefined;
        seen.push([item.request.name, exchange?.kind, status]);
      },
    });
    expect(seen).toEqual([
      ['a', 'soap', 200],
      ['b', 'rest', 200],
    ]);
  });

  describe('with the definition cached in the project', () => {
    beforeAll(async () => {
      await importWsdl(
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

describe('runRequests with a baseline', () => {
  /** Writes `<slug>.request.yaml` (existence only) and, when given, the golden beside it. */
  function saveGolden(project: Project, requestId: string, golden?: string): void {
    const location = requestFileLocation(project, requestId)!;
    const folder = join(dir, ...location.dir.split('/'));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${location.slug}.request.yaml`), 'x\n');
    if (golden !== undefined) writeFileSync(join(folder, `${location.slug}.golden.yaml`), golden);
  }

  const baseline = (project: Project, require = false) => ({
    baseline: { source: (item: SelectedRequest) => readGoldenFile(dir, project, item.request.id), require },
  });

  // `/text-plain-json` always answers {"labelled":"text/plain"}.
  const golden = (body: string, ignore = '[]'): string => `savedAt: s\nignore: ${ignore}\nbody: '${body}'\n`;

  it('passes a matching response and counts it', async () => {
    const project = makeProject([], [restRequest('bm', 0, '/text-plain-json', OK_REST)]);
    saveGolden(project, 'rest-bm', golden('{"labelled": "text/plain"}'));
    const result = await runRequests(all(project), contextFor(project), baseline(project));
    const [only] = result.requests;
    expect(only?.outcome).toBe('passed');
    expect(only?.baseline?.status).toBe('matched');
    expect(only?.assertions.at(-1)).toMatchObject({ type: 'baseline', outcome: 'passed' });
    expect(result.summary.baseline).toEqual({ matched: 1, differs: 0, missing: 0 });
  });

  it('fails a different response and keeps its exchange', async () => {
    const project = makeProject([], [restRequest('bd', 0, '/text-plain-json', OK_REST)]);
    saveGolden(project, 'rest-bd', golden('{"labelled": "other"}'));
    const [only] = (await runRequests(all(project), contextFor(project), baseline(project))).requests;
    expect(only?.outcome).toBe('failed');
    expect(only?.baseline?.status).toBe('differs');
    expect(only?.exchange).toBeDefined();
  });

  it('honours the golden ignore rules', async () => {
    const project = makeProject([], [restRequest('bi', 0, '/text-plain-json', OK_REST)]);
    saveGolden(project, 'rest-bi', golden('{"labelled": "other"}', '["/labelled"]'));
    const [only] = (await runRequests(all(project), contextFor(project), baseline(project))).requests;
    expect(only?.outcome).toBe('passed');
    expect(only?.baseline).toMatchObject({ status: 'matched', ignored: 1 });
  });

  it('notes a missing golden, and errors it under require', async () => {
    const project = makeProject([], [restRequest('bn', 0, '/text-plain-json', OK_REST)]);
    saveGolden(project, 'rest-bn');
    const loose = (await runRequests(all(project), contextFor(project), baseline(project))).requests[0];
    expect(loose?.outcome).toBe('passed');
    expect(loose?.baseline).toEqual({ status: 'missing' });
    const strict = (await runRequests(all(project), contextFor(project), baseline(project, true))).requests[0];
    expect(strict?.outcome).toBe('errored');
    expect(strict?.error?.code).toBe('baseline-missing');
  });

  it('errors an unreadable golden', async () => {
    const project = makeProject([], [restRequest('bu', 0, '/text-plain-json', OK_REST)]);
    saveGolden(project, 'rest-bu', 'savedAt: [\n');
    const [only] = (await runRequests(all(project), contextFor(project), baseline(project))).requests;
    expect(only?.outcome).toBe('errored');
    expect(only?.baseline?.status).toBe('unreadable');
  });

  it('adds nothing for a request that errored on send', async () => {
    const project = makeProject([soapRequest('bx', 0, await deadUrl(), OK_SOAP)]);
    const [only] = (await runRequests(all(project), contextFor(project), baseline(project))).requests;
    expect(only?.outcome).toBe('errored');
    expect(only?.baseline).toBeUndefined();
  });

  it('keeps an already errored outcome errored when the baseline differs', async () => {
    const project = makeProject([], [restRequest('be', 0, '/text-plain-json', [{ type: 'schema' }])]);
    saveGolden(project, 'rest-be', golden('{"labelled": "other"}'));
    const [only] = (await runRequests(all(project), contextFor(project), baseline(project))).requests;
    expect(only?.outcome).toBe('errored');
    expect(only?.baseline?.status).toBe('differs');
  });

  it('leaves results without baseline fields when not asked', async () => {
    const project = makeProject([], [restRequest('bo', 0, '/text-plain-json', OK_REST)]);
    const result = await runRequests(all(project), contextFor(project));
    expect(result.summary.baseline).toBeUndefined();
    expect(result.requests[0]?.baseline).toBeUndefined();
  });
});
