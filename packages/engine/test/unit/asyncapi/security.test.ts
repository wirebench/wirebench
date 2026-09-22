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
  it('reports an http scheme with no scheme stated', () => {
    const skip = authFromScheme({ key: 'k', type: 'http' });
    expect('reason' in skip ? skip.reason : '').toBe('http (no scheme) authentication is not supported');
  });
  it('reports an httpApiKey missing a name even in a supported place', () => {
    const skip = authFromScheme({ key: 'k', type: 'httpApiKey', in: 'query' });
    expect('reason' in skip ? skip.reason : '').toContain('an API key in query cannot be sent');
  });
  it('reports an apiKey with no place stated', () => {
    const skip = authFromScheme({ key: 'k', type: 'apiKey' });
    expect('reason' in skip ? skip.reason : '').toBe('an API key carried in the connection is not supported');
  });
  it('openIdConnect with an unsupported flow reports the flow by name', () => {
    const skip = authFromScheme({ key: 'k', type: 'openIdConnect', grant: 'implicit' });
    expect('reason' in skip ? skip.reason : '').toBe('the OAuth2 implicit flow is not supported');
  });
  it('openIdConnect with no flow stated says so', () => {
    const skip = authFromScheme({ key: 'k', type: 'openIdConnect' });
    expect('reason' in skip ? skip.reason : '').toBe('openIdConnect names no flow Wirebench can run');
  });
  it('openIdConnect with authorization-code maps like oauth2 and carries the authorizationUrl', () => {
    const auth = authFromScheme({
      key: 'k',
      type: 'openIdConnect',
      grant: 'authorization-code',
      tokenUrl: 'https://id.test/token',
      authorizationUrl: 'https://id.test/authorize',
    });
    expect(auth).toMatchObject({
      type: 'oauth2',
      grant: 'authorization-code',
      tokenUrl: 'https://id.test/token',
      authorizationUrl: 'https://id.test/authorize',
    });
  });
  it('oauth2 with no tokenUrl or scopes defaults them', () => {
    const auth = authFromScheme({ key: 'k', type: 'oauth2', grant: 'client-credentials' });
    expect(auth).toMatchObject({ type: 'oauth2', tokenUrl: '', scopes: [] });
    expect(auth).not.toHaveProperty('authorizationUrl');
  });
  it('reports an unknown scheme type by name', () => {
    const skip = authFromScheme({ key: 'k', type: 'plain' });
    expect('reason' in skip ? skip.reason : '').toBe('plain authentication is not supported on WebSocket');
  });
  it('skip() falls back to the type when no key is given', () => {
    const skip = authFromScheme({ type: 'X509' });
    expect(skip).toMatchObject({ where: 'security X509' });
  });
});
