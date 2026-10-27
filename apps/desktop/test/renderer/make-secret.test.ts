/**
 * *Make secret* (#634): which variable names offer it, the secret name a variable gets, and the
 * store-then-replace flow, which refuses a name the project already has rather than overwrite it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isSecretLikeName,
  makeSecret,
  offersMakeSecret,
  secretNameFor,
} from '../../src/renderer/features/environments/make-secret.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { ProjectWire } from '@wirebench/wire/wire-types';

describe('isSecretLikeName', () => {
  it.each([
    'token',
    'Token',
    'password',
    'passwd',
    'secret',
    'apiKey',
    'api_key',
    'apikey',
    'API-KEY',
    'key',
    'secret_key',
    'accessToken',
    'refresh_token',
    'X-Auth-Token',
    'dbPassword',
    'client_secret',
    'credentials',
    'auth',
    'basicAuth',
    'Authorization',
  ])('reads %s as secret-like', (name) => {
    expect(isSecretLikeName(name)).toBe(true);
  });

  it.each([
    'keyboard',
    'author',
    'tokenizer',
    'monkey',
    'cacheKey',
    'publicKey',
    'keyId',
    'authMode',
    'tokenUrl',
    'token_endpoint',
    'passwordPolicy',
    'secretName',
    'host',
    'baseUrl',
    '',
    '__',
  ])('does not read %s as secret-like', (name) => {
    expect(isSecretLikeName(name)).toBe(false);
  });
});

describe('offersMakeSecret', () => {
  it('needs a secret-like name and a plain, non-empty value', () => {
    expect(offersMakeSecret('token', 's3cret')).toBe(true);
    expect(offersMakeSecret('host', 's3cret')).toBe(false);
    expect(offersMakeSecret('token', '')).toBe(false);
    expect(offersMakeSecret('token', '   ')).toBe(false);
  });

  it('is not offered for a value that is already a token or refers to another variable', () => {
    expect(offersMakeSecret('token', '${secret:token}')).toBe(false);
    expect(offersMakeSecret('token', 'Bearer ${accessToken}')).toBe(false);
  });
});

describe('secretNameFor', () => {
  it('keeps a name a token can carry, and replaces the characters it cannot', () => {
    expect(secretNameFor('apiKey')).toBe('apiKey');
    expect(secretNameFor(' token ')).toBe('token');
    expect(secretNameFor('api-key')).toBe('api_key');
    expect(secretNameFor('X-Auth.Token')).toBe('X_Auth_Token');
    expect(secretNameFor('2fa-token')).toBe('_2fa_token');
  });
});

function project(id: string, name: string): ProjectWire {
  return { id, name } as unknown as ProjectWire;
}

describe('makeSecret', () => {
  const tokens = vi.fn();
  const setValue = vi.fn();

  beforeEach(() => {
    tokens.mockReset().mockResolvedValue({ ok: true, value: { tokens: [] } });
    setValue.mockReset().mockResolvedValue({ ok: true, value: { replaced: false } });
    installWirebenchApi({ secretScan: { tokens, setValue } });
    useProjectStore.setState({ projects: { p1: project('p1', 'Billing'), p2: project('p2', 'Crm') } });
  });

  it('stores the value for each project and answers the token', async () => {
    const result = await makeSecret({ projectIds: ['p1', 'p2'], name: 'api-key', value: 's3cret' });

    expect(result).toEqual({ ok: true, token: '${secret:api_key}' });
    expect(setValue).toHaveBeenCalledWith({ projectId: 'p1', name: 'api_key', value: 's3cret' });
    expect(setValue).toHaveBeenCalledWith({ projectId: 'p2', name: 'api_key', value: 's3cret' });
  });

  it('refuses a name any project already uses or stores, before storing anything', async () => {
    tokens.mockImplementation(({ projectId }: { projectId: string }) =>
      Promise.resolve({
        ok: true,
        value: { tokens: projectId === 'p2' ? [{ name: 'token', stored: false }] : [] },
      }),
    );

    const result = await makeSecret({ projectIds: ['p1', 'p2'], name: 'token', value: 's3cret' });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('Crm already has a secret named "token"');
    expect(setValue).not.toHaveBeenCalled();
  });

  it('counts a name that differs only in case as taken', async () => {
    tokens.mockResolvedValue({ ok: true, value: { tokens: [{ name: 'TOKEN', stored: true }] } });

    const result = await makeSecret({ projectIds: ['p1'], name: 'token', value: 's3cret' });

    expect(result.ok).toBe(false);
    expect(setValue).not.toHaveBeenCalled();
  });

  it('refuses with no project, or a project that is not open', async () => {
    expect((await makeSecret({ projectIds: [], name: 'token', value: 'x' })).ok).toBe(false);
    const closed = await makeSecret({ projectIds: ['p9'], name: 'token', value: 'x' });
    expect(closed.ok ? '' : closed.message).toContain('is not open');
    expect(setValue).not.toHaveBeenCalled();
  });

  it('passes a failed store on as the message', async () => {
    setValue.mockResolvedValue({ ok: false, error: { code: 'keychain', message: 'The keychain is locked' } });

    const result = await makeSecret({ projectIds: ['p1'], name: 'token', value: 's3cret' });

    expect(result).toEqual({ ok: false, message: 'The keychain is locked' });
  });
});
