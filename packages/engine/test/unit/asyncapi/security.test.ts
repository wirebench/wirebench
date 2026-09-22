import { describe, expect, it } from 'vitest';
import { authFromScheme } from '../../../src/asyncapi/security.js';

describe('authFromScheme', () => {
  it.each([
    [
      { key: 'k', type: 'httpApiKey', name: 'token', in: 'query' },
      { type: 'api-key', name: 'token', in: 'query' },
    ],
    [
      { key: 'k', type: 'httpApiKey', name: 'X-Key', in: 'header' },
      { type: 'api-key', name: 'X-Key', in: 'header' },
    ],
    [{ key: 'k', type: 'http', scheme: 'basic' }, { type: 'basic' }],
    [{ key: 'k', type: 'http', scheme: 'bearer' }, { type: 'bearer' }],
    [{ key: 'k', type: 'userPassword' }, { type: 'basic' }],
    [
      { key: 'k', type: 'oauth2', grant: 'client-credentials', tokenUrl: 'https://id.test/token', scopes: ['chat'] },
      {
        type: 'oauth2',
        grant: 'client-credentials',
        tokenUrl: 'https://id.test/token',
        clientId: '',
        scopes: ['chat'],
      },
    ],
  ] as const)('%o', (scheme, expected) => expect(authFromScheme(scheme)).toMatchObject(expected));

  it('reports X509', () => {
    const skip = authFromScheme({ key: 'cert', type: 'X509' });
    expect(skip).toMatchObject({ where: 'security cert' });
    expect('reason' in skip ? skip.reason : '').toContain('client certificate');
  });
  it('reports an apiKey carried in the user name', () =>
    expect(authFromScheme({ key: 'k', type: 'apiKey', in: 'user' })).toHaveProperty('reason'));
  it('reports an httpApiKey in a cookie', () =>
    expect(authFromScheme({ key: 'k', type: 'httpApiKey', name: 'c', in: 'cookie' })).toHaveProperty('reason'));
  it('never fills a secret', () => {
    const auth = authFromScheme({ key: 'k', type: 'http', scheme: 'bearer' });
    expect(JSON.stringify(auth)).not.toMatch(/Ref|token"/);
  });
});
