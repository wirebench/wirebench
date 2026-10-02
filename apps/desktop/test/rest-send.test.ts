// @vitest-environment node
/**
 * Resolving a REST send in main, as the send itself resolves it through the engine (`previewRest`,
 * which the editor's badge and the cURL export read): the base URL under an environment, the
 * editor's unsaved draft, the settings ladder, property expansion, which credentials a folder chain
 * lands on, and the proxy the host chooses for the send.
 *
 * The point of each case is that the renderer could not have worked it out: it has no environment,
 * no project model and no keychain, so anything it got wrong here would be sent to the wrong place
 * with the wrong credentials.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  generateServerCert,
  generateTestCa,
  startTestProxy,
  startTestRestServer,
  type TestRestServer,
} from '@wirebench/engine/test-helpers';
import {
  DEFAULT_PREFERENCES,
  createApi,
  createFolder,
  createProject,
  createRestRequest,
  entry,
  mergePreferences,
} from '@wirebench/engine';
import type { Environment, Preferences, Project, RestApi } from '@wirebench/engine';
import { resolveAuthConfig } from '../src/main/secret-resolver.js';
import { previewRest, sendThroughEngine, type RestPreview } from '../src/main/send/exchange.js';
import type { RestRequestPatchWire } from '../src/shared/wire-types.js';
import { sendDepsFor } from './helpers/send-deps.js';

const UAT: Environment = {
  id: 'env-uat',
  name: 'uat',
  slug: 'uat',
  order: 0,
  endpoints: {},
  properties: { base: 'https://uat.test/api', petId: '42' },
  disabledProperties: [],
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
  return {
    ...createProject('Demo', { id: 'p1' }),
    properties: { tier: 'gold' },
    environments: [UAT],
    activeEnvironmentId: UAT.id,
    apis: [api],
  };
}

/** `requestId` of `project` resolved as its send would resolve it, under the project's active environment. */
async function resolve(
  project: Project,
  requestId: string,
  options: { readonly draft?: RestRequestPatchWire; readonly preferences?: Preferences } = {},
): Promise<RestPreview | undefined> {
  const { preferences } = options;
  const deps = sendDepsFor(project, {
    project: {
      runContextFor: () => ({
        project,
        projectDir: '/tmp/none',
        globals: {},
        ...(project.activeEnvironmentId !== undefined ? { environmentId: project.activeEnvironmentId } : {}),
      }),
    },
    ...(preferences !== undefined ? { preferences: () => preferences } : {}),
  });
  return await previewRest(deps, requestId, options.draft);
}

let server: TestRestServer;

beforeAll(async () => {
  server = await startTestRestServer();
});

afterAll(async () => {
  await server.close();
});

describe('resolving a REST send (previewRest)', () => {
  it('expands the base URL, the path parameter and the header', async () => {
    const resolved = (await resolve(seeded(), 'req-1'))!;

    expect(resolved.input.baseUrl).toBe('https://uat.test/api');
    expect(resolved.input.request.pathParams).toEqual([{ name: 'petId', value: '42', enabled: true }]);
    expect(resolved.input.request.headers).toEqual([{ name: 'X-Tier', value: 'gold', enabled: true }]);
    expect(resolved.unresolved).toEqual([]);
    expect(resolved.baseUrlSource).toBe('api');
  });

  it('takes an environment override for the API, and says so', async () => {
    const project = seeded();
    const withEnv: Project = {
      ...project,
      environments: [{ ...UAT, endpoints: { [project.apis[0]!.slug]: 'https://second.test' } }],
    };
    const resolved = (await resolve(withEnv, 'req-1'))!;

    expect(resolved.input.baseUrl).toBe('https://second.test');
    expect(resolved.baseUrlSource).toBe('environment');
  });

  it('reports a property nothing resolved rather than leaving the caller to notice', async () => {
    const resolved = (await resolve(seeded(), 'req-1', { draft: { url: '/pet/${#Env#nope}' } }))!;

    expect(resolved.unresolved.map((ref) => ref.name)).toEqual(['nope']);
  });

  it('sends what the editor is looking at, without persisting it', async () => {
    const project = seeded();
    const resolved = (await resolve(project, 'req-1', {
      draft: {
        method: 'POST',
        url: '/pets',
        pathParams: [],
        body: { kind: 'raw', language: 'json', text: '{"tier":"${tier}"}' },
      },
    }))!;

    expect(resolved.input.request.method).toBe('POST');
    expect(resolved.input.request.body).toEqual({ kind: 'raw', language: 'json', text: '{"tier":"gold"}' });
    // The saved model is untouched: the draft applies to this send only.
    expect(project.apis[0]!.requests[0]!.method).toBe('GET');
  });

  it('climbs the settings ladder: request over API over project', async () => {
    // A project always carries a timeout, so for a *saved* request the preference is the floor the
    // project setting itself was defaulted from rather than a fourth rung reachable from here; the
    // engine's own test covers the preference layer directly.
    const project = seeded();
    const preferences = mergePreferences({ http: { socketTimeoutMs: 11_000 } });

    const fromProject = (await resolve(project, 'req-1', { preferences }))!;
    expect(fromProject.input.settings.timeoutMs).toBe(project.settings.defaultTimeoutMs);

    const fromRequest = (await resolve(project, 'req-1', { draft: { settings: { timeoutMs: 250 } }, preferences }))!;
    expect(fromRequest.input.settings.timeoutMs).toBe(250);
  });

  it('follows redirects by default, as a REST client should', async () => {
    const resolved = (await resolve(seeded(), 'req-1'))!;
    expect(resolved.input.settings.followRedirects).toBe(DEFAULT_PREFERENCES.rest.followRedirects);
  });

  it('resolves the credentials the folder chain lands on, still as references', async () => {
    const project = seeded();

    const root = (await resolve(project, 'req-1'))!;
    expect(root.auth).toEqual({ type: 'api-key', name: 'api_key', in: 'query', valueRef: 'sec_key' });

    const inFolder = (await resolve(project, 'req-admin'))!;
    expect(inFolder.auth).toEqual({ type: 'bearer', tokenRef: 'sec_token' });
  });

  it('lets the editor draft change which credentials apply', async () => {
    const resolved = (await resolve(seeded(), 'req-admin', { draft: { auth: { type: 'none' } } }))!;

    expect(resolved.auth).toEqual({ type: 'none' });
  });

  it('escapes substituted values into the body when the request asks to', async () => {
    const project = { ...seeded(), properties: { tier: 'gold', quote: 'a"b' } };
    const resolved = (await resolve(project, 'req-1', {
      draft: {
        body: { kind: 'raw', language: 'json', text: '{"q":"${quote}"}' },
        settings: { escapeProperties: true },
      },
    }))!;

    const body = resolved.input.request.body;
    expect(body.kind === 'raw' && body.text).toBe('{"q":"a\\"b"}');
  });

  it('is undefined for a request that no longer exists', async () => {
    expect(await resolve(seeded(), 'gone')).toBeUndefined();
  });

  it("sends past an untrusted certificate only when the request's settings trust it", async () => {
    // A CA the process does not trust, and no anchors lent: only `trustInvalid` lets the send through.
    const cert = generateServerCert(generateTestCa());
    const https = await startTestRestServer({ tls: { cert: cert.certPem, key: cert.keyPem } });
    try {
      const sendWith = (trustInvalid: boolean) => {
        const request = createRestRequest('Echo', { id: 'req-tls', url: '/echo' });
        const project = seeded({
          baseUrl: https.url,
          auth: { type: 'none' },
          requests: [{ ...request, settings: { ...request.settings, trustInvalid } }],
        });
        return sendThroughEngine(sendDepsFor(project), 's1', 'req-tls', { draft: { kind: 'rest' } });
      };
      expect((await sendWith(true)).http.status).toBe(200);
      await expect(sendWith(false)).rejects.toMatchObject({ code: expect.stringMatching(/tls/) as unknown });
    } finally {
      await https.close();
    }
  });

  it('passes the host proxy through to the send', async () => {
    const proxy = await startTestProxy();
    try {
      const project = seeded({ baseUrl: server.url, auth: { type: 'none' } });
      const deps = sendDepsFor(project, {
        getSecret: () => Promise.resolve('tok'),
        project: { proxyFor: () => Promise.resolve({ url: proxy.url }) },
      });
      await sendThroughEngine(deps, 's1', 'req-admin', { draft: { kind: 'rest', draft: { url: '/echo' } } });

      expect(proxy.requests.map((request) => request.target)).toEqual([`${server.url}/echo`]);
    } finally {
      await proxy.close();
    }
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
