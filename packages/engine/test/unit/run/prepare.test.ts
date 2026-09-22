import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { prepareSend } from '../../../src/run/prepare.js';
import type { RunContext } from '../../../src/run/prepare.js';
import type { HttpExchange, HttpRequest } from '../../../src/http/types.js';
import { selectRequests } from '../../../src/run/select.js';
import { DEFAULT_PROJECT_SETTINGS, DEFAULT_REQUEST_PROPERTIES, FORMAT_VERSION } from '../../../src/project/model.js';
import type {
  AuthConfig,
  Environment,
  Interface,
  Project,
  SoapOwnerAuth,
  SoapRequestDef,
  WssRef,
} from '../../../src/project/model.js';
import { createGrpcApi, createGrpcFolder, createGrpcRequest } from '../../../src/grpc/model.js';
import type { GrpcRequestDef } from '../../../src/grpc/model.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import type { RestBody } from '../../../src/rest/model.js';
import { normalizeWsa } from '../../../src/wsa/model.js';
import type { WsaConfigPatch } from '../../../src/wsa/model.js';
import { generateClientCert, generateTestCa } from '../../helpers/test-certs.js';

interface ProjectOptions {
  readonly soapAuth?: SoapOwnerAuth;
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
    wsApis: [],
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
function oauth(grant: 'client-credentials' | 'authorization-code'): AuthConfig {
  return {
    type: 'oauth2',
    grant,
    tokenUrl: 'https://auth.test/token',
    clientId: 'c',
    scopes: [],
    clientAuth: 'basic',
    pkce: true,
  };
}

function tokenExchange(accessToken: string): HttpExchange {
  const body = new TextEncoder().encode(JSON.stringify({ access_token: accessToken, token_type: 'Bearer' }));
  return {
    request: { url: 'https://auth.test/token', method: 'POST', headers: {} },
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    rawHeaders: [],
    body,
    rawBody: body,
  } as unknown as HttpExchange;
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

  it('resolves a bearer owner through the secret getter', async () => {
    const project = makeProject({ soapAuth: { type: 'bearer', tokenRef: 'sec_1' } });
    const prepared = await prepareSend(soapOf(project), contextFor(project, { environmentId: 'env-test' }));
    expect(prepared.kind === 'soap' && prepared.input.auth).toMatchObject({ type: 'bearer', token: 'pw' });
  });

  it("refuses a SOAP owner's authorization-code grant the same way a REST one is refused", async () => {
    const project = makeProject({ soapAuth: oauth('authorization-code') as SoapOwnerAuth });
    await expect(
      prepareSend(soapOf(project), contextFor(project, { environmentId: 'env-test' })),
    ).rejects.toMatchObject({
      code: 'auth-grant-unsupported',
      message: 'This request signs in through a browser (OAuth2 authorization code), which a pipeline cannot do.',
      details: { path: soapOf(project).path },
    });
  });

  it("sends a SOAP owner's client-credentials token, fetched with the run's timeout and masked", async () => {
    const project = makeProject({ soapAuth: oauth('client-credentials') as SoapOwnerAuth });
    const sent: HttpRequest[] = [];
    const seen: string[] = [];
    const prepared = await prepareSend(
      soapOf(project),
      contextFor(project, {
        environmentId: 'env-test',
        timeoutMs: 1234,
        fetchToken: (request) => {
          sent.push(request);
          return Promise.resolve(tokenExchange('tok-s'));
        },
        onSecretValue: (value) => seen.push(value),
      }),
    );
    expect(prepared.kind === 'soap' && prepared.input.auth).toEqual({ type: 'oauth2', accessToken: 'tok-s' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: 'https://auth.test/token', timeoutMs: 1234 });
    expect(seen).toContain('tok-s');
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

  it("takes the default wsa:Action from the host's hook, and leaves it empty without one", async () => {
    const on = makeProject({ ifaceWsa: { enabled: true, version: '2005/08' } });
    const hooked = await prepareSend(
      soapOf(on),
      contextFor(on, {
        environmentId: 'env-test',
        defaultWsaActionFor: (selected) => `urn:default:${selected.operation.name}`,
      }),
    );
    expect(hooked.kind === 'soap' && hooked.input.wsa?.defaultAction).toBe('urn:default:Op');
    const bare = await prepareSend(soapOf(on), contextFor(on, { environmentId: 'env-test' }));
    expect(bare.kind === 'soap' && bare.input.wsa?.defaultAction).toBe('');
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

  it('refuses the OAuth2 authorization-code grant, which needs a browser', async () => {
    const browser = makeProject({ restAuth: oauth('authorization-code') });
    await expect(
      prepareSend(restOf(browser), contextFor(browser, { environmentId: 'env-test' })),
    ).rejects.toMatchObject({ code: 'auth-grant-unsupported' });
  });

  it("sends a client-credentials token as a bearer header, fetched with the request's timeout and proxy", async () => {
    const project = makeProject({ restAuth: oauth('client-credentials') });
    const sent: HttpRequest[] = [];
    const seen: string[] = [];
    const prepared = await prepareSend(
      restOf(project),
      contextFor(project, {
        environmentId: 'env-test',
        timeoutMs: 1234,
        proxyFor: (url) => (url === 'https://auth.test/token' ? { url: 'http://proxy.test:8080' } : undefined),
        fetchToken: (request) => {
          sent.push(request);
          return Promise.resolve(tokenExchange('tok-1'));
        },
        onSecretValue: (value) => seen.push(value),
      }),
    );
    expect(prepared.kind === 'rest' && prepared.input.auth).toEqual({ type: 'oauth2', accessToken: 'tok-1' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      url: 'https://auth.test/token',
      timeoutMs: 1234,
      proxy: { url: 'http://proxy.test:8080' },
    });
    expect(seen).toEqual(['tok-1']);
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

describe('prepareSend — ${secret:name} tokens', () => {
  const tokenSecrets = (ref: string): Promise<string | undefined> =>
    Promise.resolve(ref === 'secret:billing_key' ? 'ghp_FAKEvalue' : undefined);

  it('expands a REST token from the getter, asking for it by pseudo-ref', async () => {
    const project = makeProject({ restUrl: '${baseUrl}/invoices/{id}?key=${secret:billing_key}' });
    const seen: string[] = [];
    const prepared = await prepareSend(
      restOf(project),
      contextFor(project, {
        environmentId: 'env-test',
        getSecret: (ref) => {
          seen.push(ref);
          return tokenSecrets(ref);
        },
      }),
    );
    expect(prepared.kind === 'rest' && prepared.input.request.url).toContain('key=ghp_FAKEvalue');
    expect(seen).toEqual(['secret:billing_key']);
  });

  it('expands a SOAP token reached through a property, and returns it in the scopes', async () => {
    const project = makeProject({ envelopeXml: '<Envelope>${key}</Envelope>' });
    const prepared = await prepareSend(
      soapOf(project),
      contextFor(project, {
        environmentId: 'env-test',
        overrides: { key: '${secret:billing_key}' },
        getSecret: tokenSecrets,
      }),
    );
    expect(prepared.kind === 'soap' && prepared.scopes.secrets).toEqual({ billing_key: 'ghp_FAKEvalue' });
  });

  it('refuses a token with no value as secret-missing, naming the secret', async () => {
    const project = makeProject({ restUrl: '${baseUrl}/x?key=${secret:nope}' });
    await expect(prepareSend(restOf(project), contextFor(project, { getSecret: tokenSecrets }))).rejects.toMatchObject({
      code: 'secret-missing',
      message: 'The secret "nope" is not on this machine — set it in Secrets.',
      details: { ref: 'secret:nope' },
    });
  });
});

describe('prepareSend — gRPC', () => {
  function grpcProject(request: Partial<GrpcRequestDef> = {}, folderAuth?: AuthConfig): Project {
    const api = createGrpcApi('Greeter', {
      id: 'api-greeter',
      slug: 'greeter',
      order: 2,
      target: 'localhost:1',
      tls: false,
      metadata: [{ name: 'x-tenant', value: '${tenant}', enabled: true }],
      auth: { type: 'bearer', tokenRef: 'sec_1' },
      folders: [
        createGrpcFolder('Admin', {
          id: 'f-admin',
          ...(folderAuth !== undefined ? { auth: folderAuth } : {}),
          requests: [
            {
              ...createGrpcRequest('Hello', {
                id: 'g-hello',
                service: 'wirebench.greet.Greeter',
                method: 'SayHello',
                message: '{"name": "${tenant}"}',
              }),
              ...request,
            },
          ],
        }),
      ],
    });
    const base = makeProject();
    return {
      ...base,
      environments: [{ ...ENV, endpoints: { ...ENV.endpoints, greeter: 'grpc.env.test:443' } }],
      grpcApis: [api],
    };
  }
  const grpcOf = (project: Project) => selectRequests(project, []).selected.find((s) => s.kind === 'grpc')!;

  it("targets the environment's override for the API, expands metadata and message, and inherits the API's auth", async () => {
    const project = grpcProject();
    const prepared = await prepareSend(grpcOf(project), contextFor(project, { environmentId: 'env-test' }));
    if (prepared.kind !== 'grpc') throw new Error('expected grpc');
    expect(prepared.input).toMatchObject({
      target: 'grpc.env.test:443',
      tls: false,
      service: 'wirebench.greet.Greeter',
      method: 'SayHello',
      metadata: [{ name: 'x-tenant', value: 'env-tenant', enabled: true }],
      auth: { type: 'bearer', token: 'pw' },
    });
    expect(prepared.messageText).toBe('{"name": "env-tenant"}');
  });

  it("falls back to the API's target with no environment, and --timeout replaces the deadline", async () => {
    const project = grpcProject({ settings: { timeoutMs: 99 } });
    const prepared = await prepareSend(
      grpcOf(project),
      contextFor(project, { overrides: { tenant: 't' }, timeoutMs: 1234 }),
    );
    expect(prepared).toMatchObject({ kind: 'grpc', input: { target: 'localhost:1', timeoutMs: 1234 } });
  });

  it("turns verification off under --insecure or the request's trustInvalid", async () => {
    const project = grpcProject({ settings: { trustInvalid: true } });
    const own = await prepareSend(grpcOf(project), contextFor(project, { environmentId: 'env-test' }));
    expect(own.kind === 'grpc' && own.input.tlsOptions?.rejectUnauthorized).toBe(false);
    const plain = grpcProject();
    const flagged = await prepareSend(grpcOf(plain), contextFor(plain, { environmentId: 'env-test', insecure: true }));
    expect(flagged.kind === 'grpc' && flagged.input.tlsOptions?.rejectUnauthorized).toBe(false);
  });

  it('expands a ${secret:name} token in the message from the getter', async () => {
    const project = grpcProject({ message: '{"key": "${secret:grpc_key}"}' });
    const prepared = await prepareSend(
      grpcOf(project),
      contextFor(project, {
        environmentId: 'env-test',
        getSecret: (ref) => (ref === 'secret:grpc_key' ? Promise.resolve('fake-grpc-key-0000') : Promise.resolve('pw')),
      }),
    );
    expect(prepared.kind === 'grpc' && prepared.messageText).toBe('{"key": "fake-grpc-key-0000"}');
  });

  it('refuses a call with a property nothing resolves', async () => {
    const project = grpcProject();
    await expect(prepareSend(grpcOf(project), contextFor(project))).rejects.toMatchObject({
      code: 'unresolved-properties',
      details: { path: 'Greeter/Admin/Hello', unresolved: ['${tenant}', '${tenant}'] },
    });
  });

  it("sends a folder's client-credentials token, and refuses the authorization-code grant", async () => {
    const project = grpcProject({}, oauth('client-credentials'));
    const prepared = await prepareSend(
      grpcOf(project),
      contextFor(project, { environmentId: 'env-test', fetchToken: () => Promise.resolve(tokenExchange('tok-g')) }),
    );
    expect(prepared.kind === 'grpc' && prepared.input.auth).toEqual({ type: 'oauth2', accessToken: 'tok-g' });
    const browser = grpcProject({}, oauth('authorization-code'));
    await expect(
      prepareSend(grpcOf(browser), contextFor(browser, { environmentId: 'env-test' })),
    ).rejects.toMatchObject({ code: 'auth-grant-unsupported', details: { path: 'Greeter/Admin/Hello' } });
  });
});
