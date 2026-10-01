/**
 * A SOAP item's override (the editor's unsent envelope, endpoint and headers): a send puts them on
 * the wire in place of the saved ones, and a reference or a `${secret:…}` in them resolves as one in
 * the saved request would.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS, DEFAULT_REQUEST_PROPERTIES, FORMAT_VERSION } from '../../../src/project/model.js';
import type { Project, SoapRequestDef } from '../../../src/project/model.js';
import type { RunContext } from '../../../src/run/context.js';
import { openExchange } from '../../../src/run/open.js';
import { createRunScope } from '../../../src/run/scope.js';
import type { RunScope } from '../../../src/protocol/module.js';
import { resolveSoap } from '../../../src/soap/run.js';
import type { SoapSelected } from '../../../src/soap/run.js';
import { normalizeWsa } from '../../../src/wsa/model.js';
import { startTestSoapServer } from '../../helpers/index.js';
import type { TestSoapServer } from '../../helpers/index.js';
import { testHost } from '../../helpers/send-host.js';

const ENVELOPE_WITH = (text: string): string =>
  `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><w:Echo xmlns:w="urn:wb"><w:text>${text}</w:text></w:Echo></soapenv:Body></soapenv:Envelope>`;

let server: TestSoapServer;
let dir: string;

beforeAll(async () => {
  server = await startTestSoapServer();
  dir = mkdtempSync(join(tmpdir(), 'wb-soap-override-'));
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

function projectWith(request: Partial<SoapRequestDef> = {}): Project {
  const saved: SoapRequestDef = {
    kind: 'soap',
    id: 'req-1',
    name: 'Echo',
    slug: 'echo',
    order: 0,
    soapVersion: '1.1',
    soapAction: 'urn:wb:Echo',
    headers: [{ name: 'X-Saved', value: 'saved' }],
    attachments: [],
    properties: DEFAULT_REQUEST_PROPERTIES,
    assertions: [],
    envelopeXml: ENVELOPE_WITH('saved'),
    // The saved endpoint faults: a send that reaches it did not take the override.
    endpointUrl: `${server.url}/fault`,
    ...request,
  };
  return {
    formatVersion: FORMAT_VERSION,
    id: 'proj-1',
    name: 'Override',
    settings: DEFAULT_PROJECT_SETTINGS,
    properties: { who: 'ada' },
    disabledProperties: [],
    interfaces: [
      {
        kind: 'soap',
        id: 'iface-1',
        name: 'Svc',
        slug: 'svc',
        order: 0,
        definitionUrl: `${server.url}/service?wsdl`,
        cacheDefinition: false,
        endpoints: [],
        wsa: normalizeWsa({ enabled: false, version: '2005/08' }),
        operations: [{ name: 'Echo', bindingName: '{urn:wb}B', slug: 'echo', order: 0, requests: [saved] }],
      },
    ],
    apis: [],
    grpcApis: [],
    wsApis: [],
    sequences: [],
    environments: [],
    wss: { outgoing: [], incoming: [], keystores: [] },
  };
}

function soapItem(project: Project): SoapSelected {
  const iface = project.interfaces[0]!;
  const operation = iface.operations[0]!;
  const request = operation.requests[0]!;
  return { kind: 'soap', path: 'Svc/Echo/Echo', group: 'Svc/Echo', iface, operation, request };
}

function scopeFor(project: Project): RunScope {
  const context: RunContext = { project, projectDir: dir, overrides: {}, host: testHost() };
  return createRunScope(context);
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('SoapSelected.override', () => {
  it('sends the override envelope to the override endpoint', async () => {
    const project = projectWith();
    const item: SoapSelected = {
      ...soapItem(project),
      override: { envelopeXml: ENVELOPE_WITH('${secret:x}'), endpoint: `${server.url}/soap` },
    };
    const sent = await openExchange(item, testHost({ 'secret:x': 'v' }), {
      scope: scopeFor(project),
      interactive: false,
    }).result;
    expect(sent.exchange?.kind === 'soap' && sent.exchange.soap.http.request.url).toBe(`${server.url}/soap`);
    expect(decode(sent.raw.rawRequest)).toContain('>v<');
    expect(decode(sent.raw.rawRequest)).not.toContain('saved<');
  });

  it("expands the override's references against the request's scopes", async () => {
    const project = projectWith();
    const item: SoapSelected = {
      ...soapItem(project),
      override: { envelopeXml: ENVELOPE_WITH('${#Project#who}'), endpoint: `${server.url}/soap` },
    };
    const sent = await openExchange(item, testHost(), { scope: scopeFor(project), interactive: false }).result;
    expect(decode(sent.raw.rawRequest)).toContain('>ada<');
  });

  it('sends the override headers in place of the saved ones', async () => {
    const project = projectWith();
    const item: SoapSelected = {
      ...soapItem(project),
      override: { endpoint: `${server.url}/soap`, headers: { 'X-Draft': 'draft' } },
    };
    const sent = await openExchange(item, testHost(), { scope: scopeFor(project), interactive: false }).result;
    const raw = decode(sent.raw.rawRequest);
    expect(raw).toMatch(/x-draft: draft/i);
    // The editor holds the request's whole header list: one it removed is not sent.
    expect(raw).not.toMatch(/x-saved/i);
    // The saved envelope still goes when the override names none.
    expect(raw).toContain('>saved<');
  });

  it('refuses an override envelope with a reference nothing resolves', async () => {
    const project = projectWith();
    const item: SoapSelected = {
      ...soapItem(project),
      override: { envelopeXml: ENVELOPE_WITH('${nope}'), endpoint: `${server.url}/soap` },
    };
    const before = server.requests.length;
    await expect(
      openExchange(item, testHost(), { scope: scopeFor(project), interactive: false }).result,
    ).rejects.toMatchObject({ code: 'unresolved-properties' });
    expect(server.requests.length).toBe(before);
  });

  it("lays an ad-hoc send's own transport knobs over the preferences'", async () => {
    const project = projectWith();
    const item: SoapSelected = {
      ...soapItem(project),
      override: { tlsMinVersion: 'TLSv1.3', compressBody: 'gzip', allowH2: true },
    };
    const context: RunContext = { project, projectDir: dir, overrides: {}, host: testHost() };
    const { input } = await resolveSoap(item, context);
    expect(input.tls?.minVersion).toBe('TLSv1.3');
    expect(input.compressBody).toBe('gzip');
    expect(input.allowH2).toBe(true);
    // Without them, the preferences decide.
    const saved = (await resolveSoap(soapItem(project), context)).input;
    expect(saved.tls?.minVersion).toBe('TLSv1.2');
    expect(saved.compressBody).toBeUndefined();
    expect(saved.allowH2).toBeUndefined();
  });
});
