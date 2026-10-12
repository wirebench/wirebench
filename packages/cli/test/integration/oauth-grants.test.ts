/**
 * `wirebench run` with the OAuth2 grants a pipeline can drive on its own (#338): the password grant,
 * then a refresh instead of a second password, and an authorization-code configuration started from
 * a refresh token in the environment. `secrets list` names both new variables, and no password or
 * token reaches the output.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestRestServer } from '@wirebench/engine/test-helpers';
import type { TestRestServer } from '@wirebench/engine/test-helpers';
import { createApi, createProject, createRestRequest, saveProject, withRestApis } from '@wirebench/engine';
import type { OAuth2Auth } from '@wirebench/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from './helpers.js';

const PASSWORD = 'resource-owner-pa55-long';
let server: TestRestServer;
let dir: string;

beforeAll(async () => {
  // Ten-second tokens sit inside the thirty-second refresh margin: the second request refreshes.
  server = await startTestRestServer({ oauthExpiresIn: 10, oauthUsers: { alice: PASSWORD } });
  dir = await mkdtemp(join(tmpdir(), 'wb-cli-oauth-'));
  const base: OAuth2Auth = {
    type: 'oauth2',
    grant: 'password',
    tokenUrl: `${server.url}/oauth2/token`,
    clientId: 'app',
    clientSecretRef: 'sec_client',
    clientSecretEnv: 'APP_SECRET',
    scopes: ['read'],
    clientAuth: 'basic',
    pkce: true,
  };
  const requests = (prefix: string): ReturnType<typeof createRestRequest>[] =>
    [0, 1].map((order) => ({
      ...createRestRequest(`${prefix}${String(order)}`, {
        id: `${prefix}-${String(order)}`,
        slug: `${prefix}${String(order)}`,
        order,
        url: '/auth/bearer',
      }),
      assertions: [{ type: 'status', equals: 200 }],
    }));
  await saveProject(
    withRestApis(createProject('OAuth', { id: 'p-oauth' }), [
      {
        ...createApi('Password', {
          id: 'api-pw',
          slug: 'password',
          order: 0,
          baseUrl: server.url,
          auth: { ...base, username: 'alice', passwordRef: 'sec_pw', passwordEnv: 'APP_PASSWORD' },
        }),
        requests: requests('pw'),
      },
      {
        ...createApi('Browser', {
          id: 'api-code',
          slug: 'browser',
          order: 1,
          baseUrl: server.url,
          auth: {
            ...base,
            grant: 'authorization-code',
            authorizationUrl: `${server.url}/oauth2/authorize`,
            refreshTokenRef: 'sec_rt',
            refreshTokenEnv: 'APP_REFRESH',
          },
        }),
        requests: requests('code').slice(0, 1),
      },
    ]),
    dir,
  );
});

afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

const env = { WIREBENCH_SECRET_APP_SECRET: 's3cret', WIREBENCH_SECRET_APP_PASSWORD: PASSWORD };

describe('wirebench run — OAuth2 grants headless', () => {
  it('signs in with the password grant, refreshes for the second request, and prints no credential', async () => {
    const before = server.oauthCalls.length;
    const { code, stdout, stderr } = await runCli(['run', dir, 'Password/pw0', 'Password/pw1', '--verbose'], env);
    expect(code).toBe(0);
    expect(server.oauthCalls.slice(before).map((call) => call.grant)).toEqual(['password', 'refresh_token']);
    for (const output of [stdout, stderr]) {
      expect(output).not.toContain(PASSWORD);
      for (const token of [...server.issuedTokens, ...server.issuedRefreshTokens]) {
        expect(output).not.toContain(token);
      }
    }
  });

  it('starts an authorization-code configuration from WIREBENCH_SECRET_APP_REFRESH', async () => {
    const seeded = await runCli(['run', dir, 'Password/pw0'], env);
    expect(seeded.code).toBe(0);
    const refreshToken = server.issuedRefreshTokens.at(-1) ?? '';
    const before = server.oauthCalls.length;
    const { code } = await runCli(['run', dir, 'Browser/code0'], {
      ...env,
      WIREBENCH_SECRET_APP_REFRESH: refreshToken,
    });
    expect(code).toBe(0);
    expect(server.oauthCalls.slice(before).map((call) => call.grant)).toEqual(['refresh_token']);
  });

  it('refuses the authorization-code configuration without the refresh token, naming the variable', async () => {
    const { code, stdout, stderr } = await runCli(['run', dir, 'Browser/code0'], env);
    expect(code).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain('WIREBENCH_SECRET_APP_REFRESH');
  });

  it('lists the password and the refresh token among the secrets a run needs', async () => {
    const { stdout } = await runCli(['secrets', 'list', dir], {});
    expect(stdout).toContain('WIREBENCH_SECRET_APP_PASSWORD');
    expect(stdout).toContain('WIREBENCH_SECRET_APP_REFRESH');
    expect(stdout).toContain('WIREBENCH_SECRET_APP_SECRET');
  });
});
