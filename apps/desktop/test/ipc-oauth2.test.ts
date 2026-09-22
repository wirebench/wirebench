// @vitest-environment node
/**
 * The `oauth2.*` channels. Two properties matter more than the plumbing: the renderer names an
 * *owner* and main reads the configuration from the model, so no caller can point the app at a
 * token endpoint of its own with the user's client secret; and the status that crosses the bridge
 * carries the token itself only when the session's show-secrets flag is on.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestRestServer, type TestRestServer } from '@wirebench/engine/test-helpers';
import type { AuthConfig, OAuth2Auth } from '@wirebench/engine';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const { registerOAuth2Channels } = await import('../src/main/ipc/oauth2.js');
const { OAuth2Service } = await import('../src/main/oauth2.js');

let server: TestRestServer;

beforeAll(async () => {
  server = await startTestRestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  handlers.clear();
});

type Envelope = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown };

function invoke(channel: string, payload: unknown): Promise<Envelope> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload) as Promise<Envelope>;
}

/** The value a successful call answered; fails the test when the call did not succeed. */
async function value<T>(channel: string, payload: unknown): Promise<T> {
  const result = await invoke(channel, payload);
  if (!result.ok) {
    throw new Error(`${channel} failed: ${JSON.stringify(result.error)}`);
  }
  return result.value as T;
}

/** The error a failing call answered with; a channel answers rather than throwing across the bridge. */
async function failure(channel: string, payload: unknown): Promise<{ code?: string }> {
  const result = await invoke(channel, payload);
  if (result.ok) {
    throw new Error(`${channel} unexpectedly succeeded`);
  }
  return result.error as { code?: string };
}

function config(overrides: Partial<OAuth2Auth> = {}): OAuth2Auth {
  return {
    type: 'oauth2',
    grant: 'client-credentials',
    tokenUrl: `${server.url}/oauth2/token`,
    clientId: 'app',
    clientSecretRef: 'sec_client',
    scopes: ['read'],
    clientAuth: 'basic',
    pkce: false,
    ...overrides,
  };
}

/** Registers the channels over a model that answers a fixed map of owner id to credentials. */
function harness(
  owners: Record<string, AuthConfig>,
  options: {
    readonly secrets?: Record<string, string>;
    readonly showSecrets?: boolean;
    readonly stored?: Record<string, string>;
    /** SOAP interfaces, endpoints and requests, answered by `soapAuthOf`. */
    readonly soapOwners?: Record<string, AuthConfig>;
  } = {},
): { readonly oauth2: InstanceType<typeof OAuth2Service>; readonly stored: Record<string, string> } {
  const stored = options.stored ?? {};
  const oauth2 = new OAuth2Service({
    openExternal: async (url) => {
      await fetch(url, { redirect: 'follow' });
    },
  });
  registerOAuth2Channels({
    oauth2,
    project: {
      restAuthOf: (id: string) => owners[id],
      ...(options.soapOwners !== undefined ? { soapAuthOf: (id: string) => options.soapOwners![id] as never } : {}),
      projectId: () => 'p1',
    },
    getSecret: (ref) => Promise.resolve((options.secrets ?? { sec_client: 's3cret' })[ref]),
    setSecret: (ref, value) => {
      stored[ref] = value;
      return Promise.resolve();
    },
    showSecrets: { get: () => options.showSecrets ?? false },
  });
  return { oauth2, stored };
}

describe('oauth2.fetchToken', () => {
  it('obtains a token for the owner the renderer named, using the stored client secret', async () => {
    harness({ 'api-1': config() });

    const status = await value<{ token?: string; redirectUri: string }>('oauth2.fetchToken', { ownerId: 'api-1' });

    expect(status).toMatchObject({ state: 'valid', scopes: ['read'] });
    expect(status.token).toBeUndefined();
    expect(status.redirectUri).toContain('http://127.0.0.1:');
  });

  it('shows the token only when the session says to show secrets', async () => {
    harness({ 'api-1': config() }, { showSecrets: true });

    const status = await value<{ token?: string }>('oauth2.fetchToken', { ownerId: 'api-1' });

    expect(status.token).toMatch(/^access-/);
  });

  it('falls back to a SOAP interface, endpoint or request when no REST owner has the id', async () => {
    harness({}, { soapOwners: { 'ep-1': config() } });

    const status = await value<{ token?: string }>('oauth2.fetchToken', { ownerId: 'ep-1' });

    expect(status).toMatchObject({ state: 'valid' });
  });

  it('refuses an owner nobody knows, and one that does not use OAuth2', async () => {
    harness({ 'req-1': { type: 'bearer', tokenRef: 'sec_token' } });

    await expect(failure('oauth2.fetchToken', { ownerId: 'gone' })).resolves.toMatchObject({ code: 'unknown-entity' });
    await expect(failure('oauth2.fetchToken', { ownerId: 'req-1' })).resolves.toMatchObject({
      code: 'oauth2-not-configured',
    });
  });

  it('fails when the stored client secret is missing rather than sending none', async () => {
    harness({ 'api-1': config() }, { secrets: {} });

    await expect(failure('oauth2.fetchToken', { ownerId: 'api-1' })).resolves.toMatchObject({
      code: 'oauth2-token-error',
    });
  });

  it('stores a refresh token only when the configuration asked for one to be remembered', async () => {
    const authCode = config({
      grant: 'authorization-code',
      authorizationUrl: `${server.url}/oauth2/authorize`,
      pkce: true,
    });
    const remembered = harness({ 'api-1': { ...authCode, refreshTokenRef: 'sec_refresh' } });
    await value('oauth2.fetchToken', { ownerId: 'api-1' });
    expect(remembered.stored['sec_refresh']).toMatch(/^refresh-/);

    handlers.clear();
    const plain = harness({ 'api-2': authCode });
    await value('oauth2.fetchToken', { ownerId: 'api-2' });
    expect(Object.keys(plain.stored)).toEqual([]);
  });
});

describe('oauth2.status, clearToken and cancel', () => {
  it('reports no token, then the one a fetch obtained, then none again after a clear', async () => {
    harness({ 'api-1': config() });

    expect(await value('oauth2.status', { ownerId: 'api-1' })).toMatchObject({ state: 'none' });
    await value('oauth2.fetchToken', { ownerId: 'api-1' });
    expect(await value('oauth2.status', { ownerId: 'api-1' })).toMatchObject({ state: 'valid' });
    expect(await value('oauth2.clearToken', { ownerId: 'api-1' })).toMatchObject({ state: 'none' });
    expect(await value('oauth2.status', { ownerId: 'api-1' })).toMatchObject({ state: 'none' });
  });

  it('names the loopback redirect URI a provider has to have registered', async () => {
    harness({ 'api-1': config() });

    const status = await value<{ redirectUri: string }>('oauth2.status', { ownerId: 'api-1' });
    expect(status.redirectUri).toBe('http://127.0.0.1:<random port>/callback');
  });

  it('says whether there was a flow to cancel', async () => {
    harness({ 'api-1': config() });

    expect(await value('oauth2.cancel', {})).toEqual({ cancelled: false });
  });
});
