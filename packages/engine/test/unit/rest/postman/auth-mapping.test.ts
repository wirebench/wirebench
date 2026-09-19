import { describe, expect, it } from 'vitest';
import { apiFromPostmanCollection } from '../../../../src/rest/postman/map.js';
import { parsePostmanCollection } from '../../../../src/rest/postman/parse.js';

const info = { name: 'C', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' };

function importAuth(auth: Record<string, unknown>) {
  return apiFromPostmanCollection(
    parsePostmanCollection({ info, auth, item: [{ name: 'R', request: { method: 'GET', url: '/x' } }] }),
  );
}

function oauth2(grant: string | undefined) {
  const attrs = [{ key: 'accessTokenUrl', value: 'https://id.example.com/token' }];
  return importAuth({
    type: 'oauth2',
    oauth2: grant === undefined ? attrs : [...attrs, { key: 'grant_type', value: grant }],
  });
}

describe('Postman auth mapping', () => {
  it.each([
    ['authorization_code', 'authorization-code'],
    ['authorization_code_with_pkce', 'authorization-code'],
    ['client_credentials', 'client-credentials'],
    [undefined, 'client-credentials'],
  ])('maps the OAuth 2.0 grant %s to %s', (grant, expected) => {
    const { api, summary } = oauth2(grant);
    expect(api.auth).toMatchObject({ type: 'oauth2', grant: expected });
    expect(summary.warnings?.some((w) => w.includes('grant'))).not.toBe(true);
  });

  it.each(['password_credentials', 'implicit'])('reports the unsupported grant %s and sets none', (grant) => {
    const { api, summary } = oauth2(grant);
    expect(api.auth).toEqual({ type: 'none' });
    expect(summary.warnings).toContain(`OAuth 2.0 grant "${grant}" is not supported; set to "none"`);
  });

  it('translates {{var}} in auth fields', () => {
    const { api } = importAuth({
      type: 'oauth2',
      oauth2: [
        { key: 'grant_type', value: 'client_credentials' },
        { key: 'accessTokenUrl', value: '{{idp}}/token' },
        { key: 'clientId', value: '{{clientId}}' },
        { key: 'scope', value: '{{scope}}' },
      ],
    });
    expect(api.auth).toMatchObject({ tokenUrl: '${idp}/token', clientId: '${clientId}', scopes: ['${scope}'] });

    expect(importAuth({ type: 'basic', basic: [{ key: 'username', value: '{{user}}' }] }).api.auth).toEqual({
      type: 'basic',
      username: '${user}',
    });
    expect(importAuth({ type: 'apikey', apikey: { key: '{{keyName}}', in: 'query' } }).api.auth).toMatchObject({
      type: 'api-key',
      name: '${keyName}',
      in: 'query',
    });
  });
});
