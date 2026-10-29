// @vitest-environment node
/**
 * The send route rule and the send bundle (hosted edition spec §18.4), on the server host: where a browser
 * send must go and why, what the agent is handed for it, and History's `sentFrom`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createApi,
  createFolder,
  createInterface,
  createProject,
  createRequest,
  createRestRequest,
  entry,
  loadProject,
  resolveScopes,
  restItemFor,
  withWssConfigs,
  type AuthConfig,
  type Environment,
  type Project,
  type RestRequestDef,
} from '@wirebench/engine';
import { sendBundleSchema } from '@wirebench/wire/agent';
import { channels } from '@wirebench/wire/ipc';
import { createHostState } from '../src/host/host-state.js';
import { HistoryService } from '../src/history-service.js';
import { HandlerTable } from '../src/ipc/register.js';
import type { RequestChannelDeps } from '../src/ipc/request.js';
import { registerSendRouteChannels } from '../src/ipc/send-route.js';
import { buildSendBundle, type SendBundleDeps } from '../src/send-bundle.js';
import {
  composedUrl,
  MAX_ROUTE_PINS,
  routeSend,
  RoutePins,
  routePinsPath,
  type SendRouteDeps,
} from '../src/send-route.js';
import { sendDepsFor } from './helpers/send-deps.js';

const SECRET_VALUE = 'S3CR3T-VALUE-ON-THE-SERVER';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wirebench-route-'));
  dirs.push(dir);
  return dir;
}

function environment(base: string): Environment {
  return {
    id: 'env-1',
    name: 'Dev',
    slug: 'dev',
    order: 0,
    endpoints: {},
    properties: { base },
    disabledProperties: [],
  };
}

interface Seed {
  readonly base?: string;
  readonly request?: Partial<RestRequestDef>;
  readonly auth?: AuthConfig;
  readonly keystores?: Project['keystores'];
}

/** One REST API with the request under a folder that has a script, beside another request and API. */
function seeded(seed: Seed = {}): Project {
  const target = createRestRequest('Get pet', {
    id: 'req-1',
    url: '/pets/1',
    headers: [entry('X-Trace', 'abc')],
    ...(seed.auth !== undefined ? { auth: seed.auth } : {}),
  });
  const api = createApi('Pets', {
    id: 'api-1',
    baseUrl: '${#Env#base}',
    scripts: { pre: { text: 'console.log("api")' }, api: 'wirebench', enabled: true, secrets: [] },
    folders: [
      createFolder('Admin', {
        id: 'f-admin',
        scripts: { pre: { text: 'console.log("folder")' }, api: 'wirebench', enabled: true, secrets: [] },
        requests: [{ ...target, ...seed.request }],
      }),
      createFolder('Other', { id: 'f-other', requests: [createRestRequest('Other', { id: 'req-other' })] }),
    ],
  });
  const unrelated = createApi('Unrelated', { id: 'api-2', baseUrl: 'https://unrelated.test' });
  return {
    ...createProject('Demo', { id: 'p1' }),
    environments: [environment(seed.base ?? 'https://8.8.8.8')],
    activeEnvironmentId: 'env-1',
    containers: { rest: [api, unrelated] },
    keystores: seed.keystores ?? [],
  };
}

function sendDeps(model: Project, projectDir = '/tmp/none') {
  return sendDepsFor(model, {
    projectDir,
    project: {
      runContextFor: (_id: string, envId?: string) => ({
        project: model,
        projectDir,
        environmentId: envId ?? model.activeEnvironmentId,
        globals: {},
      }),
      scopesFor: (_id: string, envId?: string) => resolveScopes(model, envId ?? model.activeEnvironmentId, {}, {}),
    } as never,
    // A getter that would hand the value out to anything that asked: the bundle must never ask.
    secretsFor: () => () => Promise.resolve(SECRET_VALUE),
    egress: { denyPrivate: false },
  });
}

function routeDeps(model: Project, extra: Partial<SendRouteDeps> = {}): SendRouteDeps {
  return { send: sendDeps(model), resolve: () => Promise.reject(new Error('no DNS here')), ...extra };
}

const ITEM = { projectId: 'p1', itemId: 'req-1' };

describe('request.route', () => {
  it('sends a public target from the server', async () => {
    await expect(routeSend(routeDeps(seeded()), ITEM)).resolves.toEqual({ route: 'server' });
  });

  it('sends a host that resolves to a public address from the server', async () => {
    const deps = routeDeps(seeded({ base: 'https://api.example.test' }), {
      resolve: () => Promise.resolve(['8.8.4.4']),
    });
    await expect(routeSend(deps, ITEM)).resolves.toEqual({ route: 'server' });
  });

  it('sends a 127.0.0.1 target through the agent', async () => {
    await expect(routeSend(routeDeps(seeded({ base: 'http://127.0.0.1:8080' })), ITEM)).resolves.toEqual({
      route: 'agent',
      needs: ['loopback-target'],
    });
  });

  it('sends a host that resolves to loopback through the agent', async () => {
    const deps = routeDeps(seeded({ base: 'http://dev.box' }), { resolve: () => Promise.resolve(['8.8.8.8', '::1']) });
    await expect(routeSend(deps, ITEM)).resolves.toEqual({ route: 'agent', needs: ['loopback-target'] });
  });

  it('sends a 10.0.0.5 target through the agent even with private ranges open on the server', async () => {
    const deps = routeDeps(seeded({ base: 'http://10.0.0.5' }));
    expect(deps.send.egress).toEqual({ denyPrivate: false });
    await expect(routeSend(deps, ITEM)).resolves.toEqual({ route: 'agent', needs: ['private-target'] });
  });

  it('sends a host the server cannot resolve through the agent: a name only the person may know', async () => {
    await expect(routeSend(routeDeps(seeded({ base: 'http://nowhere.invalid' })), ITEM)).resolves.toEqual({
      route: 'agent',
      needs: ['private-target'],
      detail: { reason: 'unresolved' },
    });
  });

  it('classifies a bracketed IPv6 literal and an IPv4-mapped one by the address they carry', async () => {
    await expect(routeSend(routeDeps(seeded({ base: 'http://[::1]:8080' })), ITEM)).resolves.toEqual({
      route: 'agent',
      needs: ['loopback-target'],
    });
    await expect(routeSend(routeDeps(seeded({ base: 'http://[::ffff:10.0.0.5]/' })), ITEM)).resolves.toEqual({
      route: 'agent',
      needs: ['private-target'],
    });
  });

  it('classifies a request URL with a host but no scheme by its own host, not the base URL', async () => {
    const deps = routeDeps(seeded({ request: { url: 'localhost:8080/x' } }), {
      resolve: (host) => Promise.resolve(host === 'localhost' ? ['127.0.0.1'] : []),
    });
    await expect(routeSend(deps, ITEM)).resolves.toEqual({ route: 'agent', needs: ['loopback-target'] });
    const input = { baseUrl: 'https://8.8.8.8', settings: {}, request: { pathParams: [], query: [] } };
    expect(composedUrl({ input: { ...input, request: { ...input.request, url: '/pets' } } } as never)).toBe(
      'https://8.8.8.8/pets',
    );
    expect(composedUrl({ input: { ...input, request: { ...input.request, url: '[::1]:81/x' } } } as never)).toBe(
      'http://[::1]:81/x',
    );
  });

  it('needs the agent for a ${#System#…} value', async () => {
    const deps = routeDeps(seeded({ request: { headers: [entry('X-User', '${#System#USER}')] } }));
    await expect(routeSend(deps, ITEM)).resolves.toEqual({ route: 'agent', needs: ['system-values'] });
  });

  it('needs the agent for a secret mapped to a secret source', async () => {
    const deps = routeDeps(seeded({ request: { headers: [entry('X-Key', '${secret:apiKey}')] } }), {
      secretSourceNames: () => ['apiKey'],
    });
    await expect(routeSend(deps, ITEM)).resolves.toEqual({ route: 'agent', needs: ['secret-source'] });
  });

  it('needs the agent for a team secret, reached through a property', async () => {
    const model = seeded({ request: { headers: [entry('X-Key', '${key}')] } });
    const withProperty = { ...model, properties: { key: '${secret:teamKey}' } };
    const deps = routeDeps(withProperty, { isTeamSecret: (_p, name) => Promise.resolve(name === 'teamKey') });
    await expect(routeSend(deps, ITEM)).resolves.toEqual({ route: 'agent', needs: ['team-secret'] });
  });

  it('needs the agent for a keystore on a machine path, but not for one inside the project', async () => {
    const keystore = (path: string): Project['keystores'] => [
      { id: 'ks-1', name: 'Client', document: { id: 'ks-1', name: 'Client', path, type: 'pkcs12' } },
    ];
    const request = { settings: { sslKeystoreRef: 'ks-1' } };
    await expect(
      routeSend(routeDeps(seeded({ request, keystores: keystore('/Users/me/client.p12') })), ITEM),
    ).resolves.toEqual({ route: 'agent', needs: ['keystore'] });
    await expect(
      routeSend(routeDeps(seeded({ request, keystores: keystore('wss/client.p12') })), ITEM),
    ).resolves.toEqual({ route: 'server' });
  });

  it('needs the agent for Kerberos', async () => {
    await expect(routeSend(routeDeps(seeded({ auth: { type: 'kerberos' } })), ITEM)).resolves.toEqual({
      route: 'agent',
      needs: ['kerberos'],
    });
  });

  it('needs the agent for NTLM with the machine logon, not for NTLM with a stored password', async () => {
    await expect(routeSend(routeDeps(seeded({ auth: { type: 'ntlm', username: 'me' } })), ITEM)).resolves.toEqual({
      route: 'agent',
      needs: ['ntlm-machine'],
    });
    await expect(
      routeSend(routeDeps(seeded({ auth: { type: 'ntlm', username: 'me', passwordRef: 'secret:pw' } })), ITEM),
    ).resolves.toEqual({ route: 'server' });
  });

  it('sends a pinned request, or a request in a pinned workspace, through the agent', async () => {
    const pins = new RoutePins(routePinsPath(tempDir()));
    const deps = routeDeps(seeded(), { pins, workspaceIdOf: () => 'ws-1' });
    await pins.set('request', 'req-1', 'agent');
    await expect(routeSend(deps, ITEM)).resolves.toEqual({ route: 'agent', needs: ['pinned'] });
    await pins.set('request', 'req-1', null);
    await expect(routeSend(deps, ITEM)).resolves.toEqual({ route: 'server' });
    await pins.set('workspace', 'ws-1', 'agent');
    await expect(routeSend(deps, ITEM)).resolves.toEqual({ route: 'agent', needs: ['pinned'] });
  });

  it(`keeps at most ${String(MAX_ROUTE_PINS)} pins of a scope`, async () => {
    const pins = new RoutePins(routePinsPath(tempDir()));
    for (let index = 0; index < MAX_ROUTE_PINS; index += 1) await pins.set('request', `r-${String(index)}`, 'agent');
    await expect(pins.set('request', 'one-more', 'agent')).rejects.toMatchObject({ code: 'route-pins-full' });
    // Pinning one already pinned, taking one off and pinning a workspace still work.
    await expect(pins.set('request', 'r-1', 'agent')).resolves.toBe('agent');
    await expect(pins.set('request', 'r-1', null)).resolves.toBeNull();
    await expect(pins.set('request', 'one-more', 'agent')).resolves.toBe('agent');
    await expect(pins.set('workspace', 'ws-1', 'agent')).resolves.toBe('agent');
  });

  it('keeps pins in a JSON file a new host reads back', async () => {
    const userData = tempDir();
    await new RoutePins(routePinsPath(userData)).set('request', 'req-1', 'agent');
    expect(JSON.parse(readFileSync(routePinsPath(userData), 'utf8'))).toMatchObject({ request: { 'req-1': 'agent' } });
    const again = new RoutePins(routePinsPath(userData));
    await again.load();
    expect(again.pinned('request', 'req-1')).toBe(true);
  });

  it('lists every need at once, in the wire order', async () => {
    const deps = routeDeps(
      seeded({
        base: 'http://192.168.1.4',
        auth: { type: 'kerberos' },
        request: { headers: [entry('U', '${#System#USER}')] },
      }),
    );
    await expect(routeSend(deps, ITEM)).resolves.toEqual({
      route: 'agent',
      needs: ['private-target', 'system-values', 'kerberos'],
    });
  });

  it('refuses a split send with `secret-missing`: the agent needs a value only the server holds', async () => {
    const deps = routeDeps(
      seeded({ base: 'http://127.0.0.1', request: { headers: [entry('Authorization', 'Bearer ${secret:token}')] } }),
      { serverSecretNames: () => Promise.resolve(['token']) },
    );
    await expect(routeSend(deps, ITEM)).rejects.toMatchObject({
      code: 'secret-missing',
      details: { name: 'token', missingOn: 'agent' },
    });
  });

  it('refuses an item the named project does not own', async () => {
    await expect(routeSend(routeDeps(seeded()), { projectId: 'other', itemId: 'req-1' })).rejects.toMatchObject({
      code: 'unknown-entity',
    });
  });
});

describe('request.bundle', () => {
  function bundled(
    seed: Seed = {},
    limits?: { maxBytes: number; maxFiles: number },
    extra: { readonly deps?: Partial<SendBundleDeps>; readonly setup?: (dir: string) => void } = {},
  ) {
    const projectDir = tempDir();
    extra.setup?.(projectDir);
    mkdirSync(join(projectDir, 'bodies'), { recursive: true });
    writeFileSync(join(projectDir, 'bodies', 'payload.bin'), Buffer.from([0, 1, 2, 3]));
    const model = seeded({
      request: {
        method: 'POST',
        headers: [entry('Authorization', 'Bearer ${secret:token}'), entry('X-User', '${#System#USER}')],
        body: {
          kind: 'binary',
          source: { kind: 'path', path: 'bodies/payload.bin' },
          contentType: 'application/octet-stream',
        },
      },
      ...seed,
    });
    return buildSendBundle(
      {
        send: sendDeps(model, projectDir),
        serverWorkspaceId: () => 'ws_server_1',
        ...(limits !== undefined ? { limits } : {}),
        ...extra.deps,
      },
      ITEM,
    );
  }

  it('carries the manifest, the folder chain with its scripts, the request and the files it reads', async () => {
    const bundle = await bundled();
    expect(sendBundleSchema.safeParse(bundle).success).toBe(true);
    const paths = bundle.files.map((file) => file.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'wirebench.yaml',
        'environments/dev.yaml',
        'apis/Pets/api.yaml',
        'apis/Pets/api.pre.ts',
        'apis/Pets/requests/Admin/folder.yaml',
        'apis/Pets/requests/Admin/folder.pre.ts',
        'apis/Pets/requests/Admin/Get pet.request.yaml',
        'bodies/payload.bin',
      ]),
    );
    // The API's and the folder's scripts travel; other requests, folders and APIs do not.
    const scripts = bundle.files.filter((file) => file.content.includes('console.log'));
    expect(scripts.map((file) => file.content).join('\n')).toContain('"api"');
    expect(scripts.map((file) => file.content).join('\n')).toContain('"folder"');
    expect(paths.some((path) => /other|unrelated/i.test(path))).toBe(false);
    expect(bundle.files.find((file) => file.path === 'bodies/payload.bin')).toEqual({
      path: 'bodies/payload.bin',
      encoding: 'base64',
      content: Buffer.from([0, 1, 2, 3]).toString('base64'),
    });
    expect(bundle).toMatchObject({
      version: 1,
      kind: 'rest',
      workspaceId: 'ws_server_1',
      itemId: 'req-1',
      environment: 'env-1',
      secretNames: ['token'],
      systemNames: ['USER'],
    });
  });

  it('loads as a project holding the one request, under the environment it is sent under', async () => {
    const bundle = await bundled();
    const dir = tempDir();
    for (const file of bundle.files) {
      mkdirSync(dirname(join(dir, file.path)), { recursive: true });
      writeFileSync(join(dir, file.path), Buffer.from(file.content, file.encoding));
    }
    const { project } = await loadProject(dir);
    expect(restItemFor(project, 'req-1')?.chain.map((folder) => folder.id)).toEqual(['f-admin']);
    expect(restItemFor(project, 'req-other')).toBeUndefined();
    expect(project.activeEnvironmentId).toBe('env-1');
  });

  it('holds no secret value, though the server holds one for the request', async () => {
    const bundle = await bundled();
    const text = JSON.stringify(bundle);
    expect(text).not.toContain(SECRET_VALUE);
    for (const file of bundle.files) {
      expect(Buffer.from(file.content, file.encoding).toString('utf8')).not.toContain(SECRET_VALUE);
    }
    expect(text).toContain('${secret:token}');
  });

  it('refuses a file outside the project', async () => {
    await expect(
      bundled({
        request: {
          body: {
            kind: 'binary',
            source: { kind: 'path', path: '../outside.bin' },
            contentType: 'application/octet-stream',
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'send-bundle-path-outside' });
  });

  it('refuses a bundle over its cap with `send-bundle-too-large`', async () => {
    await expect(bundled({}, { maxBytes: 200, maxFiles: 2000 })).rejects.toMatchObject({
      code: 'send-bundle-too-large',
    });
    await expect(bundled({}, { maxBytes: 1024 * 1024, maxFiles: 3 })).rejects.toMatchObject({
      code: 'send-bundle-too-large',
    });
  });
});

describe('History says where a send went out from', () => {
  const restResult = (sendId: string) => ({
    sendId,
    durationMs: 12,
    http: {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      rawHeaders: [['content-type', 'application/json']] as [string, string][],
      bodyBase64: '',
      rawBodyBase64: '',
      rawRequestBase64: Buffer.from('GET /pets/1 HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n').toString('base64'),
      rawResponseBase64: Buffer.from('HTTP/1.1 200 OK\r\n\r\n{}').toString('base64'),
      truncated: false,
      httpVersion: '1.1' as const,
      timings: { startedAt: new Date().toISOString(), totalMs: 12 },
      redirects: [],
      request: { url: 'http://127.0.0.1/pets/1', method: 'GET', headers: { authorization: 'Bearer ***' } },
    },
    url: 'http://127.0.0.1/pets/1',
    method: 'GET',
    text: '{}',
    language: 'json' as const,
    cookies: [],
    methodChanged: false,
    problems: [],
    sentFrom: 'agent' as const,
  });

  async function host(sendOrigin?: 'server') {
    const model = seeded({ base: 'http://127.0.0.1' });
    const hostState = createHostState();
    const history = new HistoryService(
      tempDir(),
      hostState.redactor,
      undefined,
      sendOrigin !== undefined ? { sendOrigin } : {},
    );
    await history.open('p1');
    const table = new HandlerTable(hostState.redactor);
    const send = sendDeps(model);
    const deps = { hostState, project: send.project, history } as unknown as RequestChannelDeps;
    registerSendRouteChannels(
      table,
      deps,
      sendOrigin === undefined
        ? undefined
        : { send, pins: new RoutePins(routePinsPath(tempDir())), serverWorkspaceId: () => 'ws_1' },
    );
    const call = (name: string, request: unknown) => table.get(name)!(request, { id: 1 } as never);
    return { history, call };
  }

  it('records an agent send through History with `sentFrom: agent`', async () => {
    const { history, call } = await host('server');
    const answer = (await call(channels.exchanges.recordAgentSend.name, {
      projectId: 'p1',
      itemId: 'req-1',
      kind: 'rest',
      result: restResult('send-1'),
    })) as { ok: boolean; value: { entry: { sentFrom: string; requestId: string } } };
    expect(answer).toMatchObject({
      ok: true,
      value: { entry: { sentFrom: 'agent', requestId: 'req-1', kind: 'rest' } },
    });
    expect(history.list({ projectId: 'p1' }).entries[0]).toMatchObject({ sentFrom: 'agent', method: 'GET' });
  });

  it('refuses an agent result without `sentFrom: agent`', async () => {
    const { call } = await host('server');
    const result: Partial<ReturnType<typeof restResult>> = restResult('send-2');
    delete result.sentFrom;
    await expect(
      call(channels.exchanges.recordAgentSend.name, { projectId: 'p1', itemId: 'req-1', kind: 'rest', result }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("stamps the server host's own sends `server`, and the desktop's none", async () => {
    const record = {
      requestId: 'req-1',
      requestName: 'Get pet',
      apiName: 'Pets',
      folderPath: '',
      method: 'GET',
      url: 'https://8.8.8.8/pets/1',
      requestHeaders: {},
      requestBody: '',
      durationMs: 3,
    };
    const server = await host('server');
    await expect(server.history.recordRestSend('p1', record)).resolves.toMatchObject({ sentFrom: 'server' });
    const desktop = await host();
    const entry = await desktop.history.recordRestSend('p1', record);
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('sentFrom');
  });

  it('on the desktop, routes every send to the server and refuses the other three', async () => {
    const { call } = await host();
    await expect(call(channels.request.route.name, ITEM)).resolves.toEqual({ ok: true, value: { route: 'server' } });
    for (const [name, request] of [
      [channels.request.bundle.name, ITEM],
      [channels.request.setRoutePin.name, { scope: 'request', id: 'req-1', pin: 'agent' }],
      [
        channels.exchanges.recordAgentSend.name,
        { projectId: 'p1', itemId: 'req-1', kind: 'rest', result: restResult('s') },
      ],
    ] as const) {
      await expect(call(name, request)).resolves.toMatchObject({
        ok: false,
        error: { code: 'host-capability-missing' },
      });
    }
  });
});

describe('request.bundle, further', () => {
  function restBundled(
    seed: Seed,
    options: {
      readonly deps?: Partial<SendBundleDeps>;
      readonly setup?: (dir: string) => void;
      readonly limits?: { maxBytes: number; maxFiles: number };
    } = {},
  ) {
    const projectDir = tempDir();
    options.setup?.(projectDir);
    const model = seeded(seed);
    return buildSendBundle(
      {
        send: sendDeps(model, projectDir),
        serverWorkspaceId: () => 'ws_server_1',
        ...(options.limits !== undefined ? { limits: options.limits } : {}),
        ...options.deps,
      },
      ITEM,
    );
  }

  it("carries the container's cached definition folder", async () => {
    const bundle = await restBundled(
      {},
      {
        setup: (dir) => {
          mkdirSync(join(dir, 'apis', 'Pets', 'definition'), { recursive: true });
          writeFileSync(join(dir, 'apis', 'Pets', 'definition', 'openapi.yaml'), 'openapi: 3.0.0\n');
        },
      },
    );
    expect(bundle.files.find((file) => file.path === 'apis/Pets/definition/openapi.yaml')).toMatchObject({
      encoding: 'base64',
      content: Buffer.from('openapi: 3.0.0\n').toString('base64'),
    });
  });

  it('refuses a file behind a link that leads out of the project', async () => {
    const outside = join(tempDir(), 'secret.bin');
    writeFileSync(outside, 'outside');
    await expect(
      restBundled(
        {
          request: {
            body: {
              kind: 'binary',
              source: { kind: 'path', path: 'bodies/link.bin' },
              contentType: 'application/octet-stream',
            },
          },
        },
        {
          setup: (dir) => {
            mkdirSync(join(dir, 'bodies'), { recursive: true });
            symlinkSync(outside, join(dir, 'bodies', 'link.bin'));
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'send-bundle-path-outside' });
  });

  it("carries the server's workspace and global values as its scopes, and folds none into the project", async () => {
    const model = seeded();
    const projectDir = tempDir();
    const send = sendDeps(model, projectDir);
    const scopesFor = send.project.scopesFor.bind(send.project);
    const withScopes = {
      ...send,
      project: {
        ...send.project,
        scopesFor: (id: string, env?: string) => ({
          ...scopesFor(id, env),
          workspace: { x: 'ws-x' },
          global: { y: 'gl-y' },
        }),
      },
    };
    const bundle = await buildSendBundle({ send: withScopes, serverWorkspaceId: () => 'ws_1' }, ITEM);
    expect(bundle.scopes).toEqual({ workspace: { x: 'ws-x' }, global: { y: 'gl-y' } });
    const manifest = bundle.files.find((file) => file.path === 'wirebench.yaml')?.content ?? '';
    expect(manifest).not.toContain('ws-x');
    expect(manifest).not.toContain('gl-y');
  });

  describe("a team secret: the workspace's team-secrets/ subtree", () => {
    function teamTree(): string {
      const dir = tempDir();
      mkdirSync(join(dir, 'values'), { recursive: true });
      mkdirSync(join(dir, 'keys'), { recursive: true });
      writeFileSync(join(dir, 'values', 'AAAA.yaml'), 'sealed: abc\n');
      writeFileSync(join(dir, 'keys', 'KKKK.yaml'), 'key: pub\n');
      return dir;
    }
    const reads = { request: { headers: [entry('Authorization', 'Bearer ${secret:teamKey}')] } };

    it('is carried as it is, by path inside the subtree, when the request reads a team secret', async () => {
      const dir = teamTree();
      const bundle = await restBundled(reads, {
        deps: { isTeamSecret: (_p, name) => Promise.resolve(name === 'teamKey'), teamSecretsDir: () => dir },
      });
      expect(sendBundleSchema.safeParse(bundle).success).toBe(true);
      expect(bundle.teamSecrets?.map((file) => file.path)).toEqual(['keys/KKKK.yaml', 'values/AAAA.yaml']);
      expect(bundle.teamSecrets?.[1]).toEqual({
        path: 'values/AAAA.yaml',
        encoding: 'base64',
        content: Buffer.from('sealed: abc\n').toString('base64'),
      });
    });

    it('is left out when the request reads no team secret', async () => {
      const dir = teamTree();
      const bundle = await restBundled(
        {},
        { deps: { isTeamSecret: () => Promise.resolve(false), teamSecretsDir: () => dir } },
      );
      expect(bundle.teamSecrets).toBeUndefined();
    });

    it('counts toward the caps and is held to the same path rules', async () => {
      const dir = teamTree();
      const deps = { isTeamSecret: () => Promise.resolve(true), teamSecretsDir: () => dir };
      const plain = await restBundled(reads, { deps });
      await expect(
        restBundled(reads, { deps, limits: { maxBytes: 1024 * 1024, maxFiles: plain.files.length + 1 } }),
      ).rejects.toMatchObject({ code: 'send-bundle-too-large' });
      const outside = join(tempDir(), 'elsewhere.yaml');
      writeFileSync(outside, 'x');
      symlinkSync(outside, join(dir, 'values', 'LINK.yaml'));
      await expect(restBundled(reads, { deps })).rejects.toMatchObject({ code: 'send-bundle-path-outside' });
    });
  });
});

describe('WS-Security configurations a SOAP request names', () => {
  /** A SOAP request whose outgoing WS-Security signs with keystore `ks-1` (at `path`), its password `secret:ksPass`. */
  function soapSeeded(path: string): Project {
    const request = {
      ...createRequest('Add', { id: 'soap-1', envelopeXml: '<e/>', soapVersion: '1.1' }),
      endpointUrl: 'https://8.8.8.8/soap',
      wssOutgoingRef: 'out-1',
    };
    const iface = createInterface('Calc', {
      id: 'iface-1',
      definitionUrl: 'https://8.8.8.8/calc?wsdl',
      cacheDefinition: false,
      operations: [{ name: 'Add', bindingName: '{urn:calc}B', slug: 'add', order: 0, requests: [request] }],
    });
    const project: Project = {
      ...createProject('Demo', { id: 'p1' }),
      containers: { soap: [iface] },
      keystores: [{ id: 'ks-1', name: 'Signer', document: { id: 'ks-1', name: 'Signer', path, type: 'pkcs12' } }],
    };
    return withWssConfigs(project, {
      outgoing: [
        {
          id: 'out-1',
          name: 'Sign',
          file: 'wss/outgoing/sign.yaml',
          document: {
            id: 'out-1',
            name: 'Sign',
            entries: [{ type: 'signature', keystoreRef: 'ks-1', passwordRef: 'secret:ksPass' }],
          },
        },
      ],
      incoming: [],
    });
  }
  const SOAP_ITEM = { projectId: 'p1', itemId: 'soap-1' };

  it('needs the agent for a signing keystore on a machine path, and its secret: password stays on the agent', async () => {
    const model = soapSeeded('/Users/me/signer.p12');
    await expect(routeSend(routeDeps(model), SOAP_ITEM)).resolves.toEqual({ route: 'agent', needs: ['keystore'] });
    await expect(
      routeSend(routeDeps(model, { serverSecretNames: () => Promise.resolve(['ksPass']) }), SOAP_ITEM),
    ).rejects.toMatchObject({ code: 'secret-missing', details: { name: 'ksPass', missingOn: 'agent' } });
  });

  it('bundles a keystore inside the project and names its password', async () => {
    const model = soapSeeded('wss/signer.p12');
    await expect(routeSend(routeDeps(model), SOAP_ITEM)).resolves.toEqual({ route: 'server' });
    const projectDir = tempDir();
    mkdirSync(join(projectDir, 'wss'), { recursive: true });
    writeFileSync(join(projectDir, 'wss', 'signer.p12'), Buffer.from([9, 9, 9]));
    const bundle = await buildSendBundle(
      { send: sendDeps(model, projectDir), serverWorkspaceId: () => 'ws_1' },
      SOAP_ITEM,
    );
    expect(bundle.secretNames).toEqual(['ksPass']);
    expect(bundle.files.find((file) => file.path === 'wss/signer.p12')).toEqual({
      path: 'wss/signer.p12',
      encoding: 'base64',
      content: Buffer.from([9, 9, 9]).toString('base64'),
    });
    expect(bundle.files.map((file) => file.path)).toContain('wss/outgoing/sign.yaml');
  });
});
