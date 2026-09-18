import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { prepareSend } from '../../../src/run/prepare.js';
import type { RunContext } from '../../../src/run/prepare.js';
import { selectRequests } from '../../../src/run/select.js';
import { DEFAULT_PROJECT_SETTINGS, DEFAULT_REQUEST_PROPERTIES, FORMAT_VERSION } from '../../../src/project/model.js';
import type {
  AuthConfig,
  EndpointAuth,
  Environment,
  Interface,
  Project,
  SoapRequestDef,
  WssRef,
} from '../../../src/project/model.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import type { RestBody } from '../../../src/rest/model.js';
import { normalizeWsa } from '../../../src/wsa/model.js';
import type { WsaConfigPatch } from '../../../src/wsa/model.js';
import { generateClientCert, generateTestCa } from '../../helpers/test-certs.js';

interface ProjectOptions {
  readonly soapAuth?: EndpointAuth;
  readonly endpoints?: Interface['endpoints'];
  readonly envelopeXml?: string;
  readonly soap?: Partial<SoapRequestDef>;
  readonly ifaceWsa?: WsaConfigPatch;
  readonly restUrl?: string;
  readonly restAuth?: AuthConfig;
  readonly restBody?: RestBody;
  readonly restSettings?: Record<string, unknown>;
  readonly keystores?: readonly WssRef[];
  readonly outgoing?: readonly WssRef[];
}

const ENV: Environment = {
  id: 'env-test',
  name: 'Test',
  slug: 'test',
  order: 0,
  endpoints: { Billing: 'https://env.example.test/soap', 'billing-api': 'https://api.env.test' },
  properties: { tenant: 'env-tenant', id: '42' },
  disabledProperties: [],
};

function makeProject(options: ProjectOptions = {}): Project {
  const request: SoapRequestDef = {
    kind: 'soap',
    id: 'req-soap',
    name: 'Get',
    slug: 'get',
    order: 0,
    soapVersion: '1.1',
    headers: [],
    attachments: [],
    properties: DEFAULT_REQUEST_PROPERTIES,
    assertions: [],
    envelopeXml: options.envelopeXml ?? '<Envelope>${tenant}</Envelope>',
    endpointId: 'ep-1',
    ...(options.soapAuth !== undefined ? { auth: options.soapAuth } : {}),
    ...options.soap,
  };
  const iface: Interface = {
    kind: 'soap',
    id: 'iface-billing',
    name: 'Billing',
    slug: 'Billing',
    order: 0,
    definitionUrl: 'http://example.test/def.wsdl',
    cacheDefinition: false,
    endpoints: options.endpoints ?? [
      { id: 'ep-1', name: 'default', url: 'https://request.example.test/soap', authMode: 'override' },
    ],
    wsa: normalizeWsa(options.ifaceWsa ?? { enabled: false, version: '2005/08' }),
    operations: [{ name: 'Op', bindingName: '{urn:t}B', slug: 'op', order: 0, requests: [request] }],
  };
  const api = createApi('Billing API', {
    id: 'api-billing',
    slug: 'billing-api',
    order: 1,
    baseUrl: 'https://api.example.test',
    requests: [
      createRestRequest('Get invoice', {
        id: 'req-rest',
        url: options.restUrl ?? '${baseUrl}/invoices/{id}',
        pathParams: [{ name: 'id', value: '${id}', enabled: true }],
        ...(options.restAuth !== undefined ? { auth: options.restAuth } : {}),
        ...(options.restBody !== undefined ? { body: options.restBody, method: 'POST' as const } : {}),
        ...(options.restSettings !== undefined ? { settings: options.restSettings } : {}),
      }),
    ],
  });
  return {
    formatVersion: FORMAT_VERSION,
    id: 'proj-1',
    name: 'Test project',
    settings: DEFAULT_PROJECT_SETTINGS,
    properties: { baseUrl: 'https://base.example.test' },
    disabledProperties: [],
    interfaces: [iface],
    apis: [api],
    grpcApis: [],
    environments: [ENV],
    wss: { outgoing: options.outgoing ?? [], incoming: [], keystores: options.keystores ?? [] },
  };
}

const getSecret = (ref: string): Promise<string | undefined> => Promise.resolve(ref === 'sec_1' ? 'pw' : undefined);

function contextFor(project: Project, extra: Partial<RunContext> = {}): RunContext {
  return { project, projectDir: projectDir(), overrides: {}, getSecret, ...extra };
}

let dir: string | undefined;
function projectDir(): string {
  dir ??= mkdtempSync(join(tmpdir(), 'wb-prepare-'));
  return dir;
}
afterAll(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

function soapOf(project: Project) {
  return selectRequests(project, []).selected.find((s) => s.kind === 'soap')!;
}
function restOf(project: Project) {
  return selectRequests(project, []).selected.find((s) => s.kind === 'rest')!;
}

describe('prepareSend — SOAP', () => {
  it("uses the environment's endpoint over the request's", async () => {
    const project = makeProject();
    const prepared = await prepareSend(soapOf(project), contextFor(project, { environmentId: 'env-test' }));
    expect(prepared.kind).toBe('soap');
    expect(prepared.kind === 'soap' && prepared.input.endpoint).toBe('https://env.example.test/soap');
  });

  it('lets a --var override beat the environment property', async () => {
    const project = makeProject();
    const prepared = await prepareSend(
      soapOf(project),
      contextFor(project, { environmentId: 'env-test', overrides: { tenant: 'cli-tenant' } }),
    );
    expect(prepared.kind === 'soap' && prepared.scopes.env).toMatchObject({ tenant: 'cli-tenant' });
  });

  it('resolves request auth through the secret getter', async () => {
    const project = makeProject({ soapAuth: { type: 'basic', username: 'svc', passwordRef: 'sec_1' } });
    const prepared = await prepareSend(soapOf(project), contextFor(project, { environmentId: 'env-test' }));
    expect(prepared.kind === 'soap' && prepared.input.auth).toMatchObject({ username: 'svc', password: 'pw' });
  });

  it('refuses a request whose password is not supplied', async () => {
    const project = makeProject({ soapAuth: { type: 'basic', username: 'svc', passwordRef: 'sec_missing' } });
    await expect(prepareSend(soapOf(project), contextFor(project))).rejects.toMatchObject({
      code: 'secret-missing',
      details: { ref: 'sec_missing' },
    });
  });

  it('refuses a request with no endpoint anywhere', async () => {
    const project = makeProject({ endpoints: [] });
    await expect(prepareSend(soapOf(project), contextFor(project))).rejects.toMatchObject({
      code: 'endpoint-unresolved',
    });
  });

  it('refuses an envelope with an unresolved property', async () => {
    const project = makeProject({ envelopeXml: '<Envelope>${nope}</Envelope>' });
    await expect(prepareSend(soapOf(project), contextFor(project))).rejects.toMatchObject({
      code: 'unresolved-properties',
      details: { unresolved: ['${nope}'] },
    });
  });

  it('carries --timeout and --insecure into the input', async () => {
    const project = makeProject();
    const prepared = await prepareSend(
      soapOf(project),
      contextFor(project, { environmentId: 'env-test', timeoutMs: 1234, insecure: true }),
    );
    expect(prepared.kind === 'soap' && prepared.input.timeoutMs).toBe(1234);
    expect(prepared.kind === 'soap' && prepared.input.tls?.rejectUnauthorized).toBe(false);
  });

  it("honours an endpoint's own trustInvalid, and only verifies otherwise", async () => {
    const trusted = makeProject({
      endpoints: [{ id: 'ep-1', name: 'd', url: 'https://x.test', authMode: 'override', trustInvalid: true }],
    });
    const prepared = await prepareSend(soapOf(trusted), contextFor(trusted, { overrides: { tenant: 't' } }));
    expect(prepared.kind === 'soap' && prepared.input.tls?.rejectUnauthorized).toBe(false);
    const strict = makeProject();
    const plain = await prepareSend(soapOf(strict), contextFor(strict, { environmentId: 'env-test' }));
    expect(plain.kind === 'soap' && plain.input.tls?.rejectUnauthorized).toBeUndefined();
  });

  it('sets WS-Addressing only when the effective configuration enables it', async () => {
    const on = makeProject({ ifaceWsa: { enabled: true, version: '2005/08' } });
    const prepared = await prepareSend(soapOf(on), contextFor(on, { environmentId: 'env-test' }));
    expect(prepared.kind === 'soap' && prepared.input.wsa?.config.enabled).toBe(true);
    const off = makeProject();
    const plain = await prepareSend(soapOf(off), contextFor(off, { environmentId: 'env-test' }));
    expect(plain.kind === 'soap' && plain.input.wsa).toBeUndefined();
  });

  it('carries saved attachments and reads them from inside the project only', async () => {
    writeFileSync(join(projectDir(), 'part.bin'), 'bytes');
    const attachment = {
      id: 'att-1',
      name: 'part.bin',
      contentType: 'application/octet-stream',
      size: 5,
      type: 'attachment' as const,
      contentId: 'part',
      cached: false,
      source: { kind: 'path' as const, path: 'part.bin' },
    };
    const project = makeProject({ soap: { attachments: [attachment] as unknown as SoapRequestDef['attachments'] } });
    const prepared = await prepareSend(soapOf(project), contextFor(project, { environmentId: 'env-test' }));
    if (prepared.kind !== 'soap') throw new Error('expected soap');
    expect(prepared.input.attachments).toHaveLength(1);
    const bytes = await prepared.input.attachmentOptions!.resolver(prepared.input.attachments![0]!);
    expect(new TextDecoder().decode(bytes)).toBe('bytes');
    await expect(prepared.input.attachmentOptions!.resolveFile!('../outside.txt')).rejects.toMatchObject({
      code: 'inline-file-outside-project',
    });

    const bare = makeProject();
    const plain = await prepareSend(soapOf(bare), contextFor(bare, { environmentId: 'env-test' }));
    expect(plain.kind === 'soap' && plain.input.attachments).toEqual([]);
  });

  it('sets WS-Security for a request that selects it and refuses a missing configuration', async () => {
    const outgoing: WssRef = {
      id: 'wss-out',
      name: 'Out',
      file: 'wss/outgoing/out.yaml',
      document: { id: 'wss-out', name: 'Out' },
    };
    const selecting = makeProject({ outgoing: [outgoing], soap: { wssOutgoingRef: 'wss-out' } });
    const prepared = await prepareSend(soapOf(selecting), contextFor(selecting, { environmentId: 'env-test' }));
    expect(prepared.kind === 'soap' && prepared.input.wss?.outgoing).toBeDefined();
    await expect(
      prepared.kind === 'soap' ? prepared.input.wss!.ctx.secrets('sec_missing') : undefined,
    ).rejects.toMatchObject({
      code: 'secret-missing',
    });

    const none = makeProject();
    const plain = await prepareSend(soapOf(none), contextFor(none, { environmentId: 'env-test' }));
    expect(plain.kind === 'soap' && plain.input.wss).toBeUndefined();

    const dangling = makeProject({ soap: { wssOutgoingRef: 'wss-gone' } });
    await expect(prepareSend(soapOf(dangling), contextFor(dangling))).rejects.toMatchObject({
      code: 'wss-config-missing',
      details: { configId: 'wss-gone' },
    });
  });

  it("presents the request's client keystore, and refuses a missing one or its missing password", async () => {
    const client = generateClientCert(generateTestCa());
    mkdirSync(join(projectDir(), 'keys'), { recursive: true });
    writeFileSync(join(projectDir(), 'keys', 'client.pem'), `${client.certPem}\n${client.keyPem}`);
    const keystore = (id: string, extra: Record<string, unknown> = {}): WssRef => ({
      id,
      name: id,
      document: { id, name: id, path: 'keys/client.pem', type: 'pem', ...extra },
    });
    const withKeys = (ref: string) =>
      makeProject({
        keystores: [keystore('ks-1'), keystore('ks-locked', { passwordSecretRef: 'sec_missing' })],
        soap: { properties: { ...DEFAULT_REQUEST_PROPERTIES, sslKeystoreRef: ref } },
      });

    const project = withKeys('ks-1');
    const prepared = await prepareSend(soapOf(project), contextFor(project, { environmentId: 'env-test' }));
    expect(prepared.kind === 'soap' && prepared.input.tls?.cert).toContain('BEGIN CERTIFICATE');
    expect(prepared.kind === 'soap' && prepared.input.tls?.key).toBeDefined();

    const plainProject = makeProject();
    const plain = await prepareSend(soapOf(plainProject), contextFor(plainProject, { environmentId: 'env-test' }));
    expect(plain.kind === 'soap' && plain.input.tls?.cert).toBeUndefined();

    const gone = withKeys('ks-gone');
    await expect(prepareSend(soapOf(gone), contextFor(gone))).rejects.toMatchObject({ code: 'keystore-missing' });
    const locked = withKeys('ks-locked');
    await expect(prepareSend(soapOf(locked), contextFor(locked))).rejects.toMatchObject({
      code: 'secret-missing',
      details: { ref: 'sec_missing' },
    });
  });
});

describe('prepareSend — REST', () => {
  it('expands the base URL and a path parameter, and refuses an unresolved property', async () => {
    const project = makeProject({ restUrl: '${baseUrl}/invoices/{id}' });
    const prepared = await prepareSend(restOf(project), contextFor(project, { environmentId: 'env-test' }));
    if (prepared.kind !== 'rest') throw new Error('expected rest');
    expect(prepared.input.baseUrl).toBe('https://api.env.test');
    expect(prepared.input.request.url).toBe('https://base.example.test/invoices/{id}');
    expect(prepared.input.request.pathParams[0]?.value).toBe('42');

    const broken = makeProject({ restUrl: '/invoices/${nope}' });
    await expect(prepareSend(restOf(broken), contextFor(broken, { environmentId: 'env-test' }))).rejects.toMatchObject({
      code: 'unresolved-properties',
      details: { unresolved: ['${nope}'] },
    });
  });

  it('refuses OAuth2, naming the browser grant separately', async () => {
    const oauth = (grant: 'client-credentials' | 'authorization-code'): AuthConfig => ({
      type: 'oauth2',
      grant,
      tokenUrl: 'https://auth.test/token',
      clientId: 'c',
      scopes: [],
      clientAuth: 'basic',
      pkce: true,
    });
    const browser = makeProject({ restAuth: oauth('authorization-code') });
    await expect(
      prepareSend(restOf(browser), contextFor(browser, { environmentId: 'env-test' })),
    ).rejects.toMatchObject({
      code: 'auth-grant-unsupported',
    });
    const machine = makeProject({ restAuth: oauth('client-credentials') });
    await expect(
      prepareSend(restOf(machine), contextFor(machine, { environmentId: 'env-test' })),
    ).rejects.toMatchObject({
      code: 'auth-grant-unsupported',
      message: 'OAuth2 is not supported by the runner yet.',
    });
  });

  it('carries --timeout and --insecure, and resolves a bearer token', async () => {
    const project = makeProject({ restAuth: { type: 'bearer', tokenRef: 'sec_1' } });
    const prepared = await prepareSend(
      restOf(project),
      contextFor(project, { environmentId: 'env-test', timeoutMs: 1234, insecure: true }),
    );
    if (prepared.kind !== 'rest') throw new Error('expected rest');
    expect(prepared.input.settings.timeoutMs).toBe(1234);
    expect(prepared.input.tls?.rejectUnauthorized).toBe(false);
    expect(prepared.input.auth).toMatchObject({ type: 'bearer', token: 'pw' });
  });

  it('reads a binary body from inside the project folder only', async () => {
    writeFileSync(join(projectDir(), 'body.bin'), 'payload');
    const project = makeProject({
      restBody: { kind: 'binary', source: { kind: 'path', path: 'body.bin' }, contentType: 'application/octet-stream' },
    });
    const prepared = await prepareSend(restOf(project), contextFor(project, { environmentId: 'env-test' }));
    if (prepared.kind !== 'rest') throw new Error('expected rest');
    const bytes = await prepared.input.resolveFile!({ kind: 'path', path: 'body.bin' });
    expect(new TextDecoder().decode(bytes)).toBe('payload');
    await expect(prepared.input.resolveFile!({ kind: 'path', path: '/etc/hosts' })).rejects.toMatchObject({
      code: 'rest-file-outside-project',
    });
  });
});
