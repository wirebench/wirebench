/**
 * Auth inheritance and application. The inheritance table is the part users will reason about
 * wrongly if it is wrong here, and the application half decides what actually reaches the wire.
 */
import { describe, expect, it } from 'vitest';
import type { AuthConfig } from '../../../src/project/model.js';
import { applyAuth, effectiveAuth, effectiveAuthIndex, missingSecretRef } from '../../../src/rest/auth.js';

const inherit: AuthConfig = { type: 'inherit' };
const none: AuthConfig = { type: 'none' };
const bearer: AuthConfig = { type: 'bearer', tokenRef: 'sec_t' };
const apiKey: AuthConfig = { type: 'api-key', name: 'X-Key', in: 'header', valueRef: 'sec_k' };

describe('effectiveAuth', () => {
  it('takes the request own configuration when it has one', () => {
    expect(effectiveAuth([bearer, apiKey, none])).toBe(bearer);
  });

  it('walks outwards past every inherit', () => {
    expect(effectiveAuth([inherit, inherit, apiKey])).toBe(apiKey);
  });

  it('treats a folder or API that configures nothing as inherit', () => {
    expect(effectiveAuth([inherit, undefined, apiKey])).toBe(apiKey);
  });

  it('stops at an explicit none, which switches authentication off', () => {
    expect(effectiveAuth([inherit, none, bearer])).toBe(none);
  });

  it('is none when the whole chain inherits', () => {
    expect(effectiveAuth([inherit, inherit, inherit])).toEqual({ type: 'none' });
    expect(effectiveAuth([])).toEqual({ type: 'none' });
  });

  it('says which link decided, so the editor can name it', () => {
    expect(effectiveAuthIndex([inherit, inherit, apiKey])).toBe(2);
    expect(effectiveAuthIndex([inherit])).toBe(-1);
  });
});

describe('applyAuth', () => {
  it('adds nothing when there are no credentials', () => {
    expect(applyAuth(undefined)).toEqual({ headers: {}, query: [] });
  });

  it('writes a bearer token, with its scheme', () => {
    expect(applyAuth({ type: 'bearer', token: 'abc' }).headers).toEqual({ Authorization: 'Bearer abc' });
    expect(applyAuth({ type: 'bearer', token: 'abc', scheme: 'Token' }).headers).toEqual({
      Authorization: 'Token abc',
    });
  });

  it('writes an OAuth2 access token as a bearer token', () => {
    expect(applyAuth({ type: 'oauth2', accessToken: 'xyz' }).headers).toEqual({ Authorization: 'Bearer xyz' });
  });

  it('puts an API key in a header or in the query, as configured', () => {
    expect(applyAuth({ type: 'api-key', name: 'X-Key', value: 'k', in: 'header' })).toEqual({
      headers: { 'X-Key': 'k' },
      query: [],
    });
    expect(applyAuth({ type: 'api-key', name: 'api_key', value: 'k', in: 'query' })).toEqual({
      headers: {},
      query: [{ name: 'api_key', value: 'k', enabled: true }],
    });
  });

  it('hands Basic and NTLM to the transport, which owns the challenge flow', () => {
    const basic = { type: 'basic', username: 'u', password: 'p', preemptive: true } as const;
    expect(applyAuth(basic)).toEqual({ headers: {}, query: [], transportAuth: basic });
    const ntlm = { type: 'ntlm', username: 'u', password: 'p', domain: 'D' } as const;
    expect(applyAuth(ntlm).transportAuth).toBe(ntlm);
  });
});

describe('missingSecretRef', () => {
  it('reports the reference a scheme still needs', () => {
    expect(missingSecretRef({ type: 'bearer' })).toBe('tokenRef');
    expect(missingSecretRef({ type: 'api-key', name: 'k', in: 'header' })).toBe('valueRef');
    expect(
      missingSecretRef({
        type: 'oauth2',
        grant: 'client-credentials',
        tokenUrl: 't',
        clientId: 'c',
        scopes: [],
        clientAuth: 'basic',
        pkce: true,
      }),
    ).toBe('clientSecretRef');
  });

  it('accepts a public OAuth2 client, which has no secret to give', () => {
    expect(
      missingSecretRef({
        type: 'oauth2',
        grant: 'authorization-code',
        tokenUrl: 't',
        clientId: 'c',
        scopes: [],
        clientAuth: 'body',
        pkce: true,
      }),
    ).toBeUndefined();
  });

  it('is undefined for a complete configuration and for the schemes without secrets', () => {
    expect(missingSecretRef(bearer)).toBeUndefined();
    expect(missingSecretRef(apiKey)).toBeUndefined();
    expect(missingSecretRef(none)).toBeUndefined();
    expect(missingSecretRef(inherit)).toBeUndefined();
  });
});
