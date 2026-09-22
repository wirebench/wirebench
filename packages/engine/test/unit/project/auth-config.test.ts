/**
 * The shared authentication model: one `AuthConfig` union serving SOAP interfaces, endpoints and
 * requests as well as REST APIs, folders and requests. Two rules matter beyond round-tripping:
 * a file written before the REST client (only `none`/`basic`/`ntlm`) must parse unchanged, and no
 * scheme may ever carry a credential *value* — only a keychain reference (ADR-0004).
 */
import { describe, expect, it } from 'vitest';
import type { ApiKeyAuth, AuthConfig, BearerAuth, OAuth2Auth } from '../../../src/project/model.js';
import { DEFAULT_OAUTH2_AUTH } from '../../../src/project/model.js';
import { authConfigSchema, endpointAuthSchema, soapOwnerAuthSchema } from '../../../src/project/schema.js';
import { authDocument } from '../../../src/project/serialize.js';

/** Parses a document the way the loader does, failing the test on a schema error. */
function parse(document: unknown): AuthConfig {
  const result = authConfigSchema.safeParse(document);
  expect(result.error?.issues).toBeUndefined();
  return result.data as AuthConfig;
}

describe('authConfigSchema', () => {
  it.each([
    ['none', { type: 'none' }],
    ['basic', { type: 'basic', username: 'u', passwordRef: 'sec_1', preemptive: true }],
    ['ntlm', { type: 'ntlm', username: 'u', passwordRef: 'sec_1', domain: 'CORP', workstation: 'WS1' }],
    ['inherit', { type: 'inherit' }],
    ['bearer', { type: 'bearer', tokenRef: 'sec_2', scheme: 'Token' }],
    ['api-key', { type: 'api-key', name: 'X-Api-Key', valueRef: 'sec_3', in: 'header' }],
  ])('round-trips %s unchanged', (_label, document) => {
    expect(authDocument(parse(document))).toEqual(document);
  });

  it('round-trips oauth2 with every field', () => {
    const document = {
      type: 'oauth2',
      grant: 'authorization-code',
      tokenUrl: 'https://id.example.test/token',
      authorizationUrl: 'https://id.example.test/authorize',
      clientId: 'app',
      clientSecretRef: 'sec_4',
      scopes: ['read', 'write'],
      audience: 'https://api.example.test',
      clientAuth: 'body',
      pkce: false,
      refreshTokenRef: 'sec_5',
    };
    expect(authDocument(parse(document))).toEqual(document);
  });

  it('fills the oauth2 defaults a hand-written document leaves out', () => {
    const auth = parse({ type: 'oauth2', grant: 'client-credentials', tokenUrl: 'https://t', clientId: 'c' });
    expect(auth).toMatchObject({ scopes: [], clientAuth: 'basic', pkce: true });
    expect(DEFAULT_OAUTH2_AUTH).toMatchObject({ scopes: [], clientAuth: 'basic', pkce: true });
  });

  it('omits an empty scope list from the document rather than writing "scopes: []"', () => {
    expect(authDocument({ ...DEFAULT_OAUTH2_AUTH, tokenUrl: 'https://t', clientId: 'c' })).not.toHaveProperty('scopes');
  });

  it('parses a pre-REST basic document into exactly the object it always was', () => {
    const document = { type: 'basic', username: 'u', passwordRef: 'sec_1' };
    expect(parse(document)).toEqual(endpointAuthSchema.parse(document));
  });

  it.each([
    [{ type: 'basic', username: 'u', password: 'hunter2' }, 'password'],
    [{ type: 'bearer', token: 'eyJ...' }, 'token'],
    [{ type: 'api-key', name: 'k', in: 'header', apiKey: 'abc' }, 'apiKey'],
    [{ type: 'oauth2', grant: 'client-credentials', tokenUrl: 't', clientId: 'c', clientSecret: 's' }, 'clientSecret'],
    [{ type: 'oauth2', grant: 'client-credentials', tokenUrl: 't', clientId: 'c', refreshToken: 'r' }, 'refreshToken'],
  ])('refuses a plaintext %# credential value', (document, key) => {
    const result = authConfigSchema.safeParse(document);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(key);
  });

  it.each([
    { type: 'basic', username: 'u', passwordRef: 'sec_1', passwordEnv: 'BILLING_PASSWORD' },
    { type: 'bearer', tokenRef: 'sec_2', tokenEnv: 'API_TOKEN' },
    { type: 'api-key', name: 'k', in: 'header', valueRef: 'sec_3', valueEnv: 'API_KEY' },
    { type: 'oauth2', grant: 'client-credentials', tokenUrl: 't', clientId: 'c', clientSecretEnv: 'CLIENT_SECRET' },
  ])('accepts a committed …Env name beside a ref (%#)', (document) => {
    const result = authConfigSchema.safeParse(document);
    expect(result.error?.issues).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it('accepts inherit where an interface would not', () => {
    expect(authConfigSchema.safeParse({ type: 'inherit' }).success).toBe(true);
    expect(endpointAuthSchema.safeParse({ type: 'inherit' }).success).toBe(false);
  });
});

describe('soapOwnerAuthSchema', () => {
  it.each([
    ['bearer', { type: 'bearer', tokenRef: 'sec_2' }],
    ['api-key', { type: 'api-key', name: 'X-Api-Key', in: 'query', valueRef: 'sec_3' }],
    ['oauth2', { type: 'oauth2', grant: 'client-credentials', tokenUrl: 'https://t', clientId: 'c' }],
  ])('accepts %s at a SOAP auth site', (_label, document) => {
    const result = soapOwnerAuthSchema.safeParse(document);
    expect(result.error?.issues).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it('fills the oauth2 defaults for a SOAP owner exactly as for a REST one', () => {
    const result = soapOwnerAuthSchema.safeParse({
      type: 'oauth2',
      grant: 'client-credentials',
      tokenUrl: 'https://t',
      clientId: 'c',
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ scopes: [], clientAuth: 'basic', pkce: true });
  });

  it.each([
    ['a Basic document', { type: 'basic', username: 'u', passwordRef: 'sec_1' }],
    ['an NTLM document', { type: 'ntlm', username: 'u', passwordRef: 'sec_1', domain: 'CORP' }],
  ])('still accepts %s, parsed the same as endpointAuthSchema would', (_label, document) => {
    const result = soapOwnerAuthSchema.safeParse(document);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(endpointAuthSchema.parse(document));
  });

  it('refuses inherit — a SOAP owner has nothing to inherit from', () => {
    expect(soapOwnerAuthSchema.safeParse({ type: 'inherit' }).success).toBe(false);
  });

  it.each([
    [{ type: 'bearer', token: 'eyJ...' }, 'token'],
    [{ type: 'api-key', name: 'k', in: 'header', apiKey: 'abc' }, 'apiKey'],
    [{ type: 'oauth2', grant: 'client-credentials', tokenUrl: 't', clientId: 'c', clientSecret: 's' }, 'clientSecret'],
    [{ type: 'basic', username: 'u', password: 'hunter2' }, 'password'],
  ])('refuses a plaintext %# credential value at a SOAP auth site', (document, key) => {
    const result = soapOwnerAuthSchema.safeParse(document);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(key);
  });
});

describe('AuthConfig narrowing', () => {
  it('narrows by type to each scheme own fields', () => {
    const configs: AuthConfig[] = [
      { type: 'bearer', tokenRef: 'sec_2' },
      { type: 'api-key', name: 'k', in: 'query', valueRef: 'sec_3' },
      { ...DEFAULT_OAUTH2_AUTH, tokenUrl: 'https://t', clientId: 'c' },
    ];
    const refs = configs.map((auth) => {
      switch (auth.type) {
        case 'bearer':
          return (auth satisfies BearerAuth).tokenRef;
        case 'api-key':
          return (auth satisfies ApiKeyAuth).valueRef;
        case 'oauth2':
          return (auth satisfies OAuth2Auth).clientSecretRef ?? 'none';
        default:
          return 'other';
      }
    });
    expect(refs).toEqual(['sec_2', 'sec_3', 'none']);
  });
});
