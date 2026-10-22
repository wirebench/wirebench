/**
 * `runRequests` against the stub authorization server with the grants and client authentication
 * #338 added: the password grant and its refresh, a browser grant started headless from a refresh
 * token in the environment, and the JWT and mutual-TLS client authentication methods.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Assertion } from '#core/assert/model';
import { DEFAULT_PROJECT_SETTINGS, FORMAT_VERSION } from '#core/project/model';
import type { OAuth2Auth, Project } from '#core/project/model';
import { createApi, createRestRequest, withRestApis } from '#protocol-rest/rest/model';
import type { RunContext } from '#core/run/context';
import type { ClientIdentity } from '#core/run/host';
import { runRequests } from '#core/run/run';
import { selectRequests } from '#core/run/select';
import { testHost } from '../../helpers/send-host.js';
import { generateClientCert, generateServerCert, generateTestCa } from '../../helpers/test-certs.js';
import { startTestRestServer } from '../../helpers/test-rest-server.js';
import type { TestRestServer } from '../../helpers/test-rest-server.js';
// The composition: the entry points fall back to the registry it installs (package split spec §3.3).
import '../../../src/protocols.js';

const ca = generateTestCa();
const clientCert = generateClientCert(ca);
const identity: ClientIdentity = { cert: clientCert.certPem, key: clientCert.keyPem };

let server: TestRestServer;
let mtls: TestRestServer;
let dir: string;

beforeAll(async () => {
  // Ten-second tokens sit inside the thirty-second refresh margin: every second request refreshes.
  server = await startTestRestServer({
    oauthExpiresIn: 10,
    oauthClient: { id: 'app', secret: 's3cret', certPem: clientCert.certPem },
  });
  const serverCert = generateServerCert(ca);
  mtls = await startTestRestServer({
    tls: { cert: serverCert.certPem, key: serverCert.keyPem, ca: ca.certPem, requestCert: true },
    oauthClient: { id: 'app', secret: 's3cret', certPem: clientCert.certPem },
  });
  dir = mkdtempSync(join(tmpdir(), 'wb-run-oauth-grants-'));
});

afterAll(async () => {
  await server.close();
  await mtls.close();
  rmSync(dir, { recursive: true, force: true });
});

function project(auth: OAuth2Auth, base: string, count = 2): Project {
  const requests = Array.from({ length: count }, (_, order) => ({
    ...createRestRequest(`r${String(order)}`, { id: `r-${String(order)}`, order, url: `${base}/auth/bearer` }),
    assertions: [{ type: 'status', equals: 200 }] satisfies Assertion[],
  }));
  return withRestApis(
    {
      formatVersion: FORMAT_VERSION,
      id: 'proj-oauth-grants',
      name: 'OAuth grants',
      settings: DEFAULT_PROJECT_SETTINGS,
      properties: { user: 'alice' },
      disabledProperties: [],
      containers: {},
      sequences: [],
      mocks: [],
      environments: [],
      keystores: [],
    },
    [{ ...createApi('Api', { id: 'api', slug: 'api', order: 0, baseUrl: '', auth }), requests }],
  );
}

function auth(base: string, extra: Partial<OAuth2Auth>): OAuth2Auth {
  return {
    type: 'oauth2',
    grant: 'client-credentials',
    tokenUrl: `${base}/oauth2/token`,
    clientId: 'app',
    clientSecretRef: 'sec_client',
    scopes: ['read'],
    clientAuth: 'basic',
    pkce: true,
    ...extra,
  };
}

async function run(
  p: Project,
  secrets: Record<string, string>,
  extra: Partial<RunContext> = {},
): Promise<Awaited<ReturnType<typeof runRequests>>> {
  const context: RunContext = {
    project: p,
    projectDir: dir,
    overrides: {},
    host: testHost(secrets, { tls: { identityFor: () => Promise.resolve(identity) } }),
    ...extra,
  };
  return runRequests(selectRequests(p, []).selected, context);
}

function callsSince(target: TestRestServer, before: number): TestRestServer['oauthCalls'] {
  return target.oauthCalls.slice(before);
}

describe('runRequests — OAuth2 grants', () => {
  it('signs in with the password grant, then refreshes rather than sending the password again', async () => {
    const before = server.oauthCalls.length;
    const result = await run(
      project(auth(server.url, { grant: 'password', username: '${user}', passwordRef: 'sec_pw' }), server.url),
      { sec_client: 's3cret', sec_pw: 'pa55' },
    );
    expect(result.requests.map((r) => r.status)).toEqual([200, 200]);
    const calls = callsSince(server, before);
    expect(calls.map((c) => c.grant)).toEqual(['password', 'refresh_token']);
    expect(calls[0]?.form).toMatchObject({ username: 'alice', password: 'pa55' });
    expect(calls[1]?.form['password']).toBeUndefined();
  });

  it('reports the provider refusing the password', async () => {
    const result = await run(
      project(auth(server.url, { grant: 'password', username: 'alice', passwordRef: 'sec_pw' }), server.url, 1),
      { sec_client: 's3cret', sec_pw: 'wrong' },
    );
    expect(result.requests[0]?.error).toMatchObject({
      code: 'oauth2-token-error',
      details: { error: 'invalid_grant' },
    });
  });

  it('starts an authorization-code configuration from a refresh token it was given', async () => {
    // A refresh token the stub really issued, as a pipeline would have it from a past sign-in.
    const seeded = await run(
      project(auth(server.url, { grant: 'password', username: 'alice', passwordRef: 'sec_pw' }), server.url, 1),
      { sec_client: 's3cret', sec_pw: 'pa55' },
    );
    expect(seeded.requests[0]?.status).toBe(200);
    const refreshToken = server.issuedRefreshTokens.at(-1) ?? '';

    const before = server.oauthCalls.length;
    const result = await run(
      project(
        auth(server.url, {
          grant: 'authorization-code',
          authorizationUrl: `${server.url}/oauth2/authorize`,
          refreshTokenRef: 'sec_rt',
          refreshTokenEnv: 'APP_REFRESH',
        }),
        server.url,
        1,
      ),
      { sec_client: 's3cret', sec_rt: refreshToken },
    );
    expect(result.requests[0]?.status).toBe(200);
    expect(callsSince(server, before).map((c) => c.grant)).toEqual(['refresh_token']);
  });

  it('refuses a browser grant with no refresh token, naming the variable to set', async () => {
    const result = await run(
      project(
        auth(server.url, {
          grant: 'device-code',
          deviceAuthorizationUrl: `${server.url}/oauth2/device`,
          refreshTokenRef: 'sec_rt',
          refreshTokenEnv: 'APP_REFRESH',
        }),
        server.url,
        1,
      ),
      { sec_client: 's3cret' },
    );
    expect(result.requests[0]?.error?.code).toBe('auth-grant-unsupported');
    expect(result.requests[0]?.error?.message).toContain('WIREBENCH_SECRET_APP_REFRESH');
  });
});

describe('runRequests — OAuth2 client authentication', () => {
  it('authenticates with client_secret_jwt', async () => {
    const before = server.oauthCalls.length;
    const result = await run(project(auth(server.url, { clientAuth: 'client-secret-jwt' }), server.url, 1), {
      sec_client: 's3cret',
    });
    expect(result.requests[0]?.status).toBe(200);
    expect(callsSince(server, before).map((c) => c.clientAuth)).toEqual(['client-secret-jwt']);
  });

  it('authenticates with private_key_jwt, signing with the keystore identity', async () => {
    const before = server.oauthCalls.length;
    const result = await run(
      project(auth(server.url, { clientAuth: 'private-key-jwt', clientKeystoreId: 'ks-1' }), server.url, 1),
      {},
    );
    expect(result.requests[0]?.status).toBe(200);
    expect(callsSince(server, before).map((c) => c.clientAuth)).toEqual(['private-key-jwt']);
  });

  it('refuses private_key_jwt with no keystore chosen', async () => {
    const result = await run(project(auth(server.url, { clientAuth: 'private-key-jwt' }), server.url, 1), {});
    expect(result.requests[0]?.error?.code).toBe('oauth2-client-key-missing');
  });

  it('authenticates with tls_client_auth, presenting the keystore certificate', async () => {
    const before = mtls.oauthCalls.length;
    const result = await run(
      project(auth(mtls.url, { clientAuth: 'tls-client-auth', clientKeystoreId: 'ks-1' }), mtls.url, 1),
      {},
      { insecure: true },
    );
    expect(result.requests[0]?.status).toBe(200);
    expect(callsSince(mtls, before).map((c) => c.clientAuth)).toEqual(['tls-client-auth']);
  });
});
