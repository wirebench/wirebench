// @vitest-environment node
/**
 * `request.restHeaders`: the headers a REST send would put on the wire, for the Headers tab.
 *
 * What matters is that the list is the send's own (the request resolved as its send resolves it,
 * typed headers winning, `omitHeaders` honoured) and that a secret never reaches it unless the
 * session's show-secrets switch is on — with the switch off, no secret is even read.
 */
import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi, createProject, createRestRequest } from '@wirebench/engine';
import type { AuthConfig, CookieJarHost, KeyValueEntry, Project } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { type RequestChannelDeps } from '../src/main/ipc/request.js';
import type { ProjectChange } from '../src/shared/wire-types.js';
import type { RequestRestHeadersResponse, RestHeaderRowWire } from '../src/shared/kinds/rest/wire.js';
import { NO_REST, PROJECT_SETTINGS, restApiWire } from './helpers/wire-defaults.js';
import { registerRequestChannelsWithKinds } from './helpers/kind-channels.js';
import { tableInto } from './helpers/ipc-table.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
const table = tableInto(handlers);

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload);
}

function unwrap<T>(result: unknown): T {
  const envelope = result as { ok: boolean; value?: T; error?: { code: string; message: string } };
  if (!envelope.ok) {
    throw new Error(`ipc failed: ${envelope.error?.code} ${envelope.error?.message}`);
  }
  return envelope.value as T;
}

/** A project holding REST request `rest-1`: `POST https://api.test/pets?dry=true` with a JSON body. */
function resolution(
  overrides: {
    readonly auth?: AuthConfig;
    readonly headers?: readonly KeyValueEntry[];
    readonly url?: string;
    readonly sendCookies?: boolean;
  } = {},
): Project {
  const request = createRestRequest('Create pet', {
    id: 'rest-1',
    method: 'POST',
    url: overrides.url ?? '/pets',
    query: [{ name: 'dry', value: 'true', enabled: true }],
    headers: [...(overrides.headers ?? [{ name: 'Content-Type', value: 'application/json', enabled: true }])],
    body: { kind: 'raw', language: 'json', text: '{"name":"Fido"}' },
    settings: {
      timeoutMs: 30_000,
      followRedirects: true,
      ...(overrides.sendCookies === true ? { sendCookies: true } : {}),
    },
    ...(overrides.auth !== undefined ? { auth: overrides.auth } : {}),
  });
  const api = createApi('Petstore', { id: 'api-1', baseUrl: 'https://api.test', requests: [request] });
  return { ...createProject('Demo', { id: 'p1' }), containers: { rest: [api] } };
}

/** The project surface these two channels touch, and nothing more. */
function project(options: { readonly rest?: Project | undefined; readonly changes?: ProjectChange[] } = {}) {
  const changes = options.changes ?? [];
  return {
    changes,
    scopesFor: () => ({ project: {}, global: {}, env: {} }),
    preflight: () => undefined as never,
    requestMeta: () => undefined,
    projectId: () => 'p1',
    requestSource: () => undefined as never,
    dumpFileFor: () => undefined,
    runContextFor: (requestId: string) =>
      requestId.startsWith('rest-') && options.rest !== undefined
        ? { project: options.rest, projectDir: '/tmp/demo' }
        : undefined,
    projectSnapshot: () => ({
      ...NO_REST,
      settings: PROJECT_SETTINGS,
      id: 'p1',
      name: 'Demo',
      dir: '/tmp/demo',
      dirty: false,
      interfaces: [],
      requests: [],
      properties: {},
      disabledProperties: [],
      environments: [],
      problems: [],
      keystores: [],
      wssOutgoing: [],
      wssIncoming: [],
      apis: [restApiWire({ id: 'api-1', baseUrl: 'https://api.test' })],
    }),
    projectMutate: (_projectId: string, change: ProjectChange) => {
      changes.push(change);
      return Promise.resolve(
        change.kind === 'add-rest-request' ? { project: null, createdId: 'rest-new' } : { project: null },
      );
    },
  } as unknown as RequestChannelDeps['project'];
}

/** Registers the channels with a stub project and an optional show-secrets flag. */
function setup(options: {
  readonly rest?: Project | undefined;
  readonly show?: boolean;
  readonly changes?: ProjectChange[];
  readonly secrets?: Record<string, string>;
  readonly stored?: { value: string; label: string }[];
  readonly cookies?: CookieJarHost;
  readonly getSecret?: (ref: string) => Promise<string | undefined>;
}): void {
  handlers.clear();
  registerRequestChannelsWithKinds(table, new EngineService(), {
    project: project({
      ...(options.rest !== undefined ? { rest: options.rest } : {}),
      ...(options.changes !== undefined ? { changes: options.changes } : {}),
    }),
    adHocScopes: () => ({ project: {}, global: {}, system: {} }),
    showSecrets: { get: () => options.show ?? false },
    getSecret: options.getSecret ?? ((ref: string) => Promise.resolve(options.secrets?.[ref])),
    ...(options.cookies !== undefined ? { cookies: () => options.cookies as CookieJarHost } : {}),
    ...(options.stored !== undefined
      ? {
          storeSecret: (value: string, label: string) => {
            options.stored?.push({ value, label });
            return Promise.resolve(`sec_${String(options.stored?.length ?? 0)}`);
          },
        }
      : {}),
  });
}

beforeEach(() => {
  handlers.clear();
});

async function headers(payload: unknown): Promise<RequestRestHeadersResponse> {
  return unwrap<RequestRestHeadersResponse>(await invoke('request.restHeaders', payload));
}

function row(response: RequestRestHeadersResponse, name: string, source?: string): RestHeaderRowWire | undefined {
  return response.headers.find((header) => header.name === name && (source === undefined || header.source === source));
}

const BEARER: AuthConfig = { type: 'bearer', tokenRef: 'sec_token' };

describe('request.restHeaders', () => {
  it('lists the preference defaults, the typed headers winning over the body type, and the transport', async () => {
    setup({ rest: resolution() });
    const response = await headers({ requestId: 'rest-1' });

    expect(row(response, 'User-Agent')?.source).toBe('preference');
    expect(row(response, 'Content-Type', 'body')?.state).toBe('overridden');
    expect(row(response, 'Content-Type', 'typed')?.value).toBe('application/json');
    expect(row(response, 'Host')).toMatchObject({ value: 'api.test', source: 'transport', state: 'sent' });
    expect(row(response, 'Content-Length')?.value).toBe(String('{"name":"Fido"}'.length));
  });

  it('masks a credential and reads no secret while the session hides them', async () => {
    const getSecret = vi.fn(() => Promise.resolve<string | undefined>('tok-1'));
    setup({ rest: resolution({ auth: BEARER }), getSecret });
    const authorization = row(await headers({ requestId: 'rest-1' }), 'Authorization');

    expect(authorization?.source).toBe('auth');
    expect(authorization?.value).not.toContain('tok-1');
    expect(authorization?.masked).toBe(true);
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('shows the credential when the session shows secrets', async () => {
    setup({ rest: resolution({ auth: BEARER }), show: true, secrets: { sec_token: 'tok-1' } });
    const authorization = row(await headers({ requestId: 'rest-1' }), 'Authorization');
    expect(authorization).toMatchObject({ value: 'Bearer tok-1', source: 'auth', state: 'sent' });
    expect(authorization?.masked).toBeUndefined();
  });

  it('follows the draft: a header it switches off is listed as omitted', async () => {
    setup({ rest: resolution() });
    const response = await headers({
      requestId: 'rest-1',
      draft: { settings: { timeoutMs: 30_000, followRedirects: true, omitHeaders: ['user-agent'] } },
    });
    expect(row(response, 'User-Agent')?.state).toBe('omitted');
  });

  it("reads the jar only for a request that sends cookies, and masks the cookie's value", async () => {
    const cookies: CookieJarHost = {
      cookiesFor: () => [
        {
          name: 'sid',
          value: 'abc123',
          domain: 'api.test',
          hostOnly: true,
          path: '/',
          secure: false,
          httpOnly: false,
          createdAt: 0,
          lastAccessAt: 0,
        } as never,
      ],
      remember: () => [],
    };
    setup({ rest: resolution(), cookies });
    expect(row(await headers({ requestId: 'rest-1' }), 'Cookie')).toBeUndefined();

    setup({ rest: resolution({ sendCookies: true }), cookies });
    const cookie = row(await headers({ requestId: 'rest-1' }), 'Cookie');
    expect(cookie?.source).toBe('cookie');
    expect(cookie?.value).not.toContain('abc123');
  });

  it('says an OAuth2 header comes at send when no token is cached', async () => {
    setup({
      rest: resolution({
        auth: {
          type: 'oauth2',
          grant: 'client-credentials',
          tokenUrl: 'https://id.test/token',
          clientId: 'c',
          scopes: [],
          clientAuth: 'body',
          pkce: false,
        },
      }),
    });
    const response = await headers({ requestId: 'rest-1' });
    expect(row(response, 'Authorization')).toBeUndefined();
    expect(response.notes?.[0]).toContain('OAuth2');
  });

  it('answers no headers for an id that is not a REST request', async () => {
    setup({ rest: resolution() });
    expect((await headers({ requestId: 'soap-1' })).headers).toEqual([]);
  });

  describe('a client-signed JWT', () => {
    const SECRET = 'jwt-shared-secret-0123456789-abcdefghijklmnop';
    const JWT: AuthConfig = {
      type: 'jwt',
      algorithm: 'HS256',
      secretRef: 'sec_jwt',
      claims: '{"sub":"svc"}',
      issuedAt: true,
      expiresInSeconds: 300,
      jwtId: false,
      in: 'header',
    };

    it('shows a masked stand-in and signs nothing while the session hides secrets', async () => {
      const getSecret = vi.fn(() => Promise.resolve<string | undefined>(SECRET));
      setup({ rest: resolution({ auth: { ...JWT, name: 'X-Jwt', prefix: '' } }), getSecret });
      const jwt = row(await headers({ requestId: 'rest-1' }), 'X-Jwt');
      expect(jwt).toMatchObject({ source: 'auth', masked: true });
      expect(getSecret).not.toHaveBeenCalled();
    });

    it('shows the token the next send carries while the session shows secrets', async () => {
      setup({ rest: resolution({ auth: JWT }), show: true, secrets: { sec_jwt: SECRET } });
      const first = row(await headers({ requestId: 'rest-1' }), 'Authorization');
      const token = first?.value.replace(/^Bearer /u, '') ?? '';
      const [head = '', body = '', signature = ''] = token.split('.');
      expect(createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')).toBe(signature);
      expect(JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))).toMatchObject({ sub: 'svc' });
      // The app's source reuses a fresh token, so a second look shows the same one.
      expect(row(await headers({ requestId: 'rest-1' }), 'Authorization')?.value).toBe(first?.value);
    });
  });
});
