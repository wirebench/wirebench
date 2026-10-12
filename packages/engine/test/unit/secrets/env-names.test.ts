import { describe, expect, it } from 'vitest';
import { envVariablesFor, secretNeedsOfAuth } from '../../../src/secrets/env-names.js';

describe('secret needs', () => {
  it('lists a basic password with its declared name', () => {
    expect(
      secretNeedsOfAuth({ type: 'basic', username: 'svc', passwordRef: 'sec_1', passwordEnv: 'BILLING_PASSWORD' }),
    ).toEqual([{ ref: 'sec_1', envName: 'BILLING_PASSWORD', purpose: 'basic password for "svc"' }]);
  });

  it('lists nothing for inherit, none, or a scheme with no ref set', () => {
    expect(secretNeedsOfAuth(undefined)).toEqual([]);
    expect(secretNeedsOfAuth({ type: 'none' })).toEqual([]);
    expect(secretNeedsOfAuth({ type: 'bearer' })).toEqual([]);
  });

  it('looks the declared name up first, then the ref', () => {
    expect(envVariablesFor({ ref: 'sec_01j8-x', envName: 'API_TOKEN' })).toEqual([
      'WIREBENCH_SECRET_API_TOKEN',
      'WIREBENCH_SECRET_SEC_01J8_X',
    ]);
    expect(envVariablesFor({ ref: 'sec_1' })).toEqual(['WIREBENCH_SECRET_SEC_1']);
  });

  it('reads a ${secret:name} pseudo-ref from WIREBENCH_SECRET_<NAME> alone', () => {
    expect(envVariablesFor({ ref: 'secret:demo_basic', envName: 'DEMO_BASIC' })).toEqual([
      'WIREBENCH_SECRET_DEMO_BASIC',
    ]);
    expect(envVariablesFor({ ref: 'secret:demo_basic' })).toEqual(['WIREBENCH_SECRET_DEMO_BASIC']);
  });

  it('lists the OAuth2 password for the password grant, and the refresh token for browser grants', () => {
    const base = {
      type: 'oauth2',
      tokenUrl: 't',
      clientId: 'app',
      scopes: [],
      clientAuth: 'basic',
      pkce: true,
    } as const;
    expect(
      secretNeedsOfAuth({
        ...base,
        grant: 'password',
        username: 'svc',
        clientSecretRef: 'sec_c',
        passwordRef: 'sec_p',
        passwordEnv: 'SVC_PASSWORD',
        refreshTokenRef: 'sec_r',
      }),
    ).toEqual([
      { ref: 'sec_c', purpose: 'OAuth2 client secret for "app"' },
      { ref: 'sec_p', envName: 'SVC_PASSWORD', purpose: 'OAuth2 password for "svc"' },
    ]);
    for (const grant of ['authorization-code', 'device-code'] as const) {
      expect(secretNeedsOfAuth({ ...base, grant, refreshTokenRef: 'sec_r', refreshTokenEnv: 'APP_REFRESH' })).toEqual([
        { ref: 'sec_r', envName: 'APP_REFRESH', purpose: 'OAuth2 refresh token for "app"' },
      ]);
    }
  });

  it('does not ask for a client secret that key-based client auth never sends', () => {
    const base = {
      type: 'oauth2',
      grant: 'client-credentials',
      tokenUrl: 't',
      clientId: 'app',
      scopes: [],
      pkce: true,
    } as const;
    for (const clientAuth of ['private-key-jwt', 'tls-client-auth'] as const) {
      expect(secretNeedsOfAuth({ ...base, clientAuth, clientSecretRef: 'sec_c' })).toEqual([]);
    }
    expect(secretNeedsOfAuth({ ...base, clientAuth: 'client-secret-jwt', clientSecretRef: 'sec_c' })).toHaveLength(1);
  });
});
