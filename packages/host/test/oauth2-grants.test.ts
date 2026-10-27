// @vitest-environment node
/**
 * The OAuth2 token service with the grants and client authentication #338 added, against the
 * stub authorization server: the password grant, the device-code flow (its pending code, polling,
 * cancelling) and the JWT client authentication methods.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  generateClientCert,
  generateTestCa,
  startTestRestServer,
  type TestRestServer,
} from '@wirebench/engine/test-helpers';
import type { OAuth2Auth } from '@wirebench/engine';
import { OAuth2Service } from '../src/oauth2.js';

const ca = generateTestCa();
const clientCert = generateClientCert(ca);
const identity = { cert: clientCert.certPem, key: clientCert.keyPem };

let server: TestRestServer;

beforeAll(async () => {
  server = await startTestRestServer({ oauthClient: { id: 'app', secret: 's3cret', certPem: clientCert.certPem } });
});

afterAll(async () => {
  await server.close();
});

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

const instant = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('the password grant', () => {
  it('obtains a token on a send, with no browser, and caches it', async () => {
    const opened: string[] = [];
    const service = new OAuth2Service({ openExternal: (url) => Promise.resolve(void opened.push(url)) });
    const ownerGrant = config({ grant: 'password', username: 'alice', passwordRef: 'sec_pw' });
    const before = server.oauthCalls.length;

    const first = await service.accessToken(ownerGrant, { credentials: { clientSecret: 's3cret', password: 'pa55' } });
    const second = await service.accessToken(ownerGrant, { credentials: { clientSecret: 's3cret', password: 'pa55' } });

    expect(second).toBe(first);
    expect(opened).toEqual([]);
    expect(server.oauthCalls.slice(before).map((call) => call.grant)).toEqual(['password']);
  });

  it('runs from Get new token too', async () => {
    const service = new OAuth2Service({ openExternal: () => Promise.resolve() });
    const ownerGrant = config({ grant: 'password', username: 'alice', passwordRef: 'sec_pw' });
    await expect(
      service.fetchToken(ownerGrant, { credentials: { clientSecret: 's3cret', password: 'pa55' } }),
    ).resolves.toMatchObject({ state: 'valid' });
  });
});

describe('the device-code grant', () => {
  const device = (): OAuth2Auth =>
    config({ grant: 'device-code', deviceAuthorizationUrl: `${server.url}/oauth2/device` });

  it('shows the user code, opens the verification page, and ends with a token once approved', async () => {
    const opened: string[] = [];
    const service = new OAuth2Service({
      openExternal: (url) => Promise.resolve(void opened.push(url)),
      sleep: instant,
    });
    const pending = service.fetchToken(device(), { credentials: { clientSecret: 's3cret' } });

    let status = service.status(device());
    while (status.device === undefined) {
      await instant();
      status = service.status(device());
    }
    expect(status).toMatchObject({
      state: 'pending',
      device: { userCode: expect.stringMatching(/^USER-/) as unknown, verificationUri: `${server.url}/device` },
    });
    expect(opened).toEqual([status.device.verificationUriComplete]);

    server.approveDevice(status.device.userCode);
    await expect(pending).resolves.toMatchObject({ state: 'valid' });
  });

  it('is cancelled from the panel, and a send never starts one', async () => {
    const service = new OAuth2Service({ openExternal: () => Promise.resolve(), sleep: instant });
    const pending = service.fetchToken(device(), { credentials: { clientSecret: 's3cret' } });
    while (service.status(device()).device === undefined) await instant();

    expect(service.cancel()).toEqual({ cancelled: true });
    await expect(pending).rejects.toMatchObject({ code: 'oauth2-cancelled' });
    expect(service.status(device())).toEqual({ state: 'none' });

    await expect(service.accessToken(device(), { credentials: { clientSecret: 's3cret' } })).rejects.toMatchObject({
      code: 'oauth2-sign-in-required',
    });
  });
});

describe('JWT client authentication', () => {
  it('signs client_secret_jwt with the client secret', async () => {
    const service = new OAuth2Service({ openExternal: () => Promise.resolve() });
    const before = server.oauthCalls.length;
    await service.accessToken(config({ clientAuth: 'client-secret-jwt' }), { credentials: { clientSecret: 's3cret' } });
    expect(server.oauthCalls.slice(before).map((call) => call.clientAuth)).toEqual(['client-secret-jwt']);
  });

  it('signs private_key_jwt with the keystore identity, and refuses without one', async () => {
    const service = new OAuth2Service({ openExternal: () => Promise.resolve() });
    const keyed = config({ clientAuth: 'private-key-jwt', clientKeystoreId: 'ks-1' });
    const before = server.oauthCalls.length;
    await service.accessToken(keyed, { identityFor: () => Promise.resolve(identity) });
    expect(server.oauthCalls.slice(before).map((call) => call.clientAuth)).toEqual(['private-key-jwt']);

    service.clear(keyed);
    await expect(service.accessToken(keyed, {})).rejects.toMatchObject({ code: 'oauth2-client-key-missing' });
  });
});
