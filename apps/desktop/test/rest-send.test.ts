/**
 * Resolving a REST send in main: the base URL under an environment, the editor's unsaved draft, the
 * settings ladder, property expansion, and which credentials a folder chain lands on.
 *
 * The point of each case is that the renderer could not have worked it out: it has no environment,
 * no project model and no keychain, so anything it got wrong here would be sent to the wrong place
 * with the wrong credentials.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  createApi,
  createFolder,
  createProject,
  createRestRequest,
  entry,
  mergePreferences,
  resolveApiBaseUrl,
} from '@wirebench/engine';
import type { Project, PropertyScopes, RestApi } from '@wirebench/engine';
import { resolveRestSend } from '../src/main/rest-send.js';
import { resolveAuthConfig } from '../src/main/secret-resolver.js';

const scopes: PropertyScopes = {
  project: { tier: 'gold' },
  env: { base: 'https://uat.test/api', petId: '42' },
  global: {},
  system: {},
};

function seeded(overrides: Partial<RestApi> = {}): Project {
  const api = createApi('Petstore', {
    id: 'api-1',
    baseUrl: '${#Env#base}',
    auth: { type: 'api-key', name: 'api_key', in: 'query', valueRef: 'sec_key' },
    requests: [
      createRestRequest('Get pet', {
        id: 'req-1',
        url: '/pet/{petId}',
        pathParams: [entry('petId', '${#Env#petId}')],
        headers: [entry('X-Tier', '${tier}')],
      }),
    ],
    folders: [
      createFolder('Admin', {
        id: 'f-admin',
        auth: { type: 'bearer', tokenRef: 'sec_token' },
        requests: [createRestRequest('Delete pet', { id: 'req-admin', method: 'DELETE', url: '/pet/1' })],
      }),
    ],
    ...overrides,
  });
  return { ...createProject('Demo', { id: 'p1' }), apis: [api] };
}

/** The resolver a project open outside a workspace uses: its own active environment. */
const ownEnvironment = (project: Project) => (api: RestApi) => resolveApiBaseUrl(project, undefined, api);

describe('resolveRestSend', () => {
  it('expands the base URL, the path parameter and the header', () => {
    const project = seeded();
    const resolved = resolveRestSend({
      project,
      requestId: 'req-1',
      scopes,
      resolveBaseUrl: ownEnvironment(project),
    })!;

    expect(resolved.input.baseUrl).toBe('https://uat.test/api');
    expect(resolved.input.request.pathParams).toEqual([{ name: 'petId', value: '42', enabled: true }]);
    expect(resolved.input.request.headers).toEqual([{ name: 'X-Tier', value: 'gold', enabled: true }]);
    expect(resolved.unresolved).toEqual([]);
    expect(resolved.baseUrlSource).toBe('api');
  });

  it('takes an environment override for the API, and says so', () => {
    const project = seeded();
    const withEnv: Project = {
      ...project,
      environments: [
        {
          id: 'env-1',
          name: 'uat',
          slug: 'uat',
          order: 0,
          endpoints: { Petstore: 'https://second.test' },
          properties: {},
          disabledProperties: [],
        },
      ],
      activeEnvironmentId: 'env-1',
    };
    const resolved = resolveRestSend({
      project: withEnv,
      requestId: 'req-1',
      scopes,
      resolveBaseUrl: (api) => resolveApiBaseUrl(withEnv, 'env-1', api),
    })!;

    expect(resolved.input.baseUrl).toBe('https://second.test');
    expect(resolved.baseUrlSource).toBe('environment');
  });

  it('reports a property nothing resolved rather than leaving the caller to notice', () => {
    const project = seeded();
    const resolved = resolveRestSend({
      project,
      requestId: 'req-1',
      draft: { url: '/pet/${#Env#nope}' },
      scopes,
      resolveBaseUrl: ownEnvironment(project),
    })!;

    expect(resolved.unresolved.map((ref) => ref.name)).toEqual(['nope']);
  });

  it('sends what the editor is looking at, without persisting it', () => {
    const project = seeded();
    const resolved = resolveRestSend({
      project,
      requestId: 'req-1',
      draft: {
        method: 'POST',
        url: '/pets',
        pathParams: [],
        body: { kind: 'raw', language: 'json', text: '{"tier":"${tier}"}' },
      },
      scopes,
      resolveBaseUrl: ownEnvironment(project),
    })!;

    expect(resolved.input.request.method).toBe('POST');
    expect(resolved.input.request.body).toEqual({ kind: 'raw', language: 'json', text: '{"tier":"gold"}' });
    // The saved model is untouched: the draft applies to this send only.
    expect(project.apis[0]!.requests[0]!.method).toBe('GET');
  });

  it('climbs the settings ladder: request over API over project', () => {
    // A project always carries a timeout, so for a *saved* request the preference is the floor the
    // project setting itself was defaulted from rather than a fourth rung reachable from here; the
    // engine's own test covers the preference layer directly.
    const project = seeded();
    const preferences = mergePreferences({ http: { socketTimeoutMs: 11_000 } });

    const fromProject = resolveRestSend({
      project,
      requestId: 'req-1',
      scopes,
      preferences,
      resolveBaseUrl: ownEnvironment(project),
    })!;
    expect(fromProject.input.settings.timeoutMs).toBe(project.settings.defaultTimeoutMs);

    const fromRequest = resolveRestSend({
      project,
      requestId: 'req-1',
      draft: { settings: { timeoutMs: 250 } },
      scopes,
      preferences,
      resolveBaseUrl: ownEnvironment(project),
    })!;
    expect(fromRequest.input.settings.timeoutMs).toBe(250);
  });

  it('follows redirects by default, as a REST client should', () => {
    const project = seeded();
    const resolved = resolveRestSend({
      project,
      requestId: 'req-1',
      scopes,
      resolveBaseUrl: ownEnvironment(project),
    })!;
    expect(resolved.input.settings.followRedirects).toBe(DEFAULT_PREFERENCES.rest.followRedirects);
  });

  it('resolves the credentials the folder chain lands on, still as references', () => {
    const project = seeded();

    const root = resolveRestSend({ project, requestId: 'req-1', scopes, resolveBaseUrl: ownEnvironment(project) })!;
    expect(root.auth).toEqual({ type: 'api-key', name: 'api_key', in: 'query', valueRef: 'sec_key' });

    const inFolder = resolveRestSend({
      project,
      requestId: 'req-admin',
      scopes,
      resolveBaseUrl: ownEnvironment(project),
    })!;
    expect(inFolder.auth).toEqual({ type: 'bearer', tokenRef: 'sec_token' });
  });

  it('lets the editor draft change which credentials apply', () => {
    const project = seeded();
    const resolved = resolveRestSend({
      project,
      requestId: 'req-admin',
      draft: { auth: { type: 'none' } },
      scopes,
      resolveBaseUrl: ownEnvironment(project),
    })!;

    expect(resolved.auth).toEqual({ type: 'none' });
  });

  it('escapes substituted values into the body when the request asks to', () => {
    const project = seeded();
    const resolved = resolveRestSend({
      project,
      requestId: 'req-1',
      draft: {
        body: { kind: 'raw', language: 'json', text: '{"q":"${quote}"}' },
        settings: { escapeProperties: true },
      },
      scopes: { ...scopes, project: { ...scopes.project, quote: 'a"b' } },
      resolveBaseUrl: ownEnvironment(project),
    })!;

    const body = resolved.input.request.body;
    expect(body.kind === 'raw' && body.text).toBe('{"q":"a\\"b"}');
  });

  it('is undefined for a request that no longer exists', () => {
    const project = seeded();
    expect(
      resolveRestSend({ project, requestId: 'gone', scopes, resolveBaseUrl: ownEnvironment(project) }),
    ).toBeUndefined();
  });

  it('passes the host TLS and proxy through untouched', () => {
    const project = seeded();
    const resolved = resolveRestSend({
      project,
      requestId: 'req-1',
      scopes,
      resolveBaseUrl: ownEnvironment(project),
      tls: { rejectUnauthorized: false },
      proxy: { url: 'http://proxy.test:8080' },
    })!;

    expect(resolved.input.tls).toMatchObject({ rejectUnauthorized: false });
    expect(resolved.input.proxy).toEqual({ url: 'http://proxy.test:8080' });
  });
});

describe('resolveAuthConfig', () => {
  const secrets: Record<string, string> = { sec_token: 'tok', sec_key: 'k3y', sec_pw: 'pw' };
  const getSecret = (ref: string): Promise<string | undefined> => Promise.resolve(secrets[ref]);

  it('resolves every reference-bearing scheme into values', async () => {
    await expect(resolveAuthConfig({ type: 'bearer', tokenRef: 'sec_token' }, getSecret)).resolves.toEqual({
      type: 'bearer',
      token: 'tok',
    });
    await expect(
      resolveAuthConfig({ type: 'api-key', name: 'api_key', in: 'query', valueRef: 'sec_key' }, getSecret),
    ).resolves.toEqual({ type: 'api-key', name: 'api_key', value: 'k3y', in: 'query' });
    await expect(
      resolveAuthConfig({ type: 'basic', username: 'u', passwordRef: 'sec_pw' }, getSecret),
    ).resolves.toEqual({ type: 'basic', username: 'u', password: 'pw', preemptive: true });
  });

  it('fails loudly on a dangling reference instead of sending nothing', async () => {
    await expect(resolveAuthConfig({ type: 'bearer', tokenRef: 'sec_gone' }, getSecret)).rejects.toMatchObject({
      code: 'secret-missing',
    });
  });

  it('is no credentials for none, inherit, or a scheme with nothing configured', async () => {
    await expect(resolveAuthConfig({ type: 'none' }, getSecret)).resolves.toBeUndefined();
    await expect(resolveAuthConfig({ type: 'inherit' }, getSecret)).resolves.toBeUndefined();
    await expect(resolveAuthConfig({ type: 'bearer' }, getSecret)).resolves.toBeUndefined();
    await expect(resolveAuthConfig(undefined, getSecret)).resolves.toBeUndefined();
  });

  it('takes an OAuth2 access token from the caller, never from the store', async () => {
    const config = {
      type: 'oauth2' as const,
      grant: 'client-credentials' as const,
      tokenUrl: 't',
      clientId: 'c',
      scopes: [],
      clientAuth: 'basic' as const,
      pkce: true,
    };
    await expect(resolveAuthConfig(config, getSecret)).resolves.toBeUndefined();
    await expect(resolveAuthConfig(config, getSecret, { accessToken: 'at' })).resolves.toEqual({
      type: 'oauth2',
      accessToken: 'at',
    });
  });
});
