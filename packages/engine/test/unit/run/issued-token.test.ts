import { describe, expect, it, vi } from 'vitest';
import { createIssuedTokenSource, issuedCacheKey } from '../../../src/run/issued-token.js';
import { createWssContext } from '../../../src/wss/model.js';
import type { IssuedToken, WssIssuedTokenEntry } from '../../../src/wss/model.js';
import type { IssuedTokenTarget } from '../../../src/wss/trust/client.js';

const entry: WssIssuedTokenEntry = {
  kind: 'issued-token',
  stsUrl: 'https://sts.test/trust',
  soapVersion: '1.2',
  trustVersion: '1.3',
  tokenType: '2.0',
  keyType: 'bearer',
  credential: { kind: 'username', username: 'alice', passwordRef: 'sec' },
  requestedLifetimeSeconds: 0,
};
const target: IssuedTokenTarget = { endpointUrl: 'https://service.test/', expand: (t) => t };
const deps = { ctx: createWssContext() };

function token(expiresAt?: string, id = '_t1'): IssuedToken {
  return {
    assertionXml: `<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}"/>`,
    assertionId: id,
    samlVersion: '2.0',
    keyType: 'bearer',
    stsHost: 'sts.test',
    cacheKey: '',
    ...(expiresAt !== undefined ? { expiresAt: new Date(expiresAt) } : {}),
  };
}

describe('createIssuedTokenSource', () => {
  it('fetches once and reuses the token until it is within a minute of expiry', async () => {
    let now = new Date('2026-10-05T10:00:00Z');
    const request = vi.fn().mockResolvedValue(token('2026-10-05T11:00:00Z'));
    const source = createIssuedTokenSource({ now: () => now, request });
    await source.get(entry, target, deps);
    await source.get(entry, target, deps);
    expect(request).toHaveBeenCalledTimes(1);
    now = new Date('2026-10-05T10:59:30Z');
    await source.get(entry, target, deps);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('shares one STS call between concurrent sends', async () => {
    const request = vi.fn().mockResolvedValue(token('2026-10-05T11:00:00Z'));
    const source = createIssuedTokenSource({ now: () => new Date('2026-10-05T10:00:00Z'), request });
    await Promise.all([source.get(entry, target, deps), source.get(entry, target, deps)]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('never caches a token with no lifetime, and says so in status', async () => {
    const request = vi.fn().mockResolvedValue(token(undefined));
    const source = createIssuedTokenSource({ request });
    await source.get(entry, target, deps);
    await source.get(entry, target, deps);
    expect(request).toHaveBeenCalledTimes(2);
    expect(source.status(entry, target)).toEqual({
      state: 'none',
      singleUse: true,
      samlVersion: '2.0',
      keyType: 'bearer',
      stsHost: 'sts.test',
    });
  });

  it('forgets the single-use mark on clear, on a later cached fetch and on a failure', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(token(undefined))
      .mockResolvedValueOnce(token('2026-10-05T11:00:00Z'))
      .mockResolvedValueOnce(token(undefined))
      .mockRejectedValueOnce(new Error('refused'));
    let now = new Date('2026-10-05T10:00:00Z');
    const source = createIssuedTokenSource({ now: () => now, request });
    await source.get(entry, target, deps);
    expect(source.status(entry, target).singleUse).toBe(true);
    source.clear(entry, target);
    expect(source.status(entry, target)).toEqual({ state: 'none' });

    await source.get(entry, target, deps);
    await source.get(entry, target, deps);
    expect(source.status(entry, target)).toMatchObject({ state: 'valid' });
    expect(source.status(entry, target).singleUse).toBeUndefined();

    now = new Date('2026-10-05T12:00:00Z');
    await source.get(entry, target, deps);
    expect(source.status(entry, target).singleUse).toBe(true);
    await expect(source.get(entry, target, deps)).rejects.toThrow('refused');
    expect(source.status(entry, target)).toEqual({ state: 'none', lastError: 'refused' });
  });

  it('never caches a failure, and keeps its message for status', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('refused'))
      .mockResolvedValue(token('2026-10-05T11:00:00Z'));
    const source = createIssuedTokenSource({ now: () => new Date('2026-10-05T10:00:00Z'), request });
    await expect(source.get(entry, target, deps)).rejects.toThrow('refused');
    expect(source.status(entry, target).lastError).toBe('refused');
    await source.get(entry, target, deps);
    expect(request).toHaveBeenCalledTimes(2);
    expect(source.status(entry, target).lastError).toBeUndefined();
  });

  it('reject and clear drop the token; peek never fetches', async () => {
    const request = vi.fn().mockResolvedValue(token('2026-10-05T11:00:00Z'));
    const source = createIssuedTokenSource({ now: () => new Date('2026-10-05T10:00:00Z'), request });
    expect(source.peek(entry, target)).toBeUndefined();
    const first = await source.get(entry, target, deps);
    expect(source.peek(entry, target)?.assertionId).toBe('_t1');
    source.reject(first);
    expect(source.peek(entry, target)).toBeUndefined();
    await source.get(entry, target, deps);
    source.clear(entry, target);
    expect(source.status(entry, target).state).toBe('none');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('reports each token to onSecretValue', async () => {
    const seen: string[] = [];
    const source = createIssuedTokenSource({
      request: vi.fn().mockResolvedValue(token('2026-10-05T11:00:00Z')),
      onSecretValue: (value) => seen.push(value),
    });
    await source.get(entry, target, deps);
    expect(seen[0]).toContain('saml2:Assertion');
  });

  it('keys on what identifies a token, and not on a secret', () => {
    const base = issuedCacheKey(entry, target);
    expect(issuedCacheKey({ ...entry, keyType: 'public-key' }, target)).not.toBe(base);
    expect(issuedCacheKey(entry, { ...target, endpointUrl: 'https://other.test/' })).not.toBe(base);
    expect(
      issuedCacheKey({ ...entry, credential: { kind: 'username', username: 'alice', passwordRef: 'other' } }, target),
    ).toBe(base);
  });

  it('a stale reject leaves a newer cached token in place', async () => {
    let now = new Date('2026-10-05T10:00:00Z');
    const request = vi
      .fn()
      .mockResolvedValueOnce(token('2026-10-05T10:30:00Z', '_old'))
      .mockResolvedValueOnce(token('2026-10-05T12:00:00Z', '_new'));
    const source = createIssuedTokenSource({ now: () => now, request });
    const old = await source.get(entry, target, deps);
    now = new Date('2026-10-05T10:29:30Z');
    await source.get(entry, target, deps);
    source.reject(old);
    expect(source.peek(entry, target)?.assertionId).toBe('_new');
  });

  it('a different expansion is a different key and a fresh fetch', async () => {
    const request = vi.fn().mockResolvedValue(token('2026-10-05T11:00:00Z'));
    const source = createIssuedTokenSource({ now: () => new Date('2026-10-05T10:00:00Z'), request });
    const withVars = { ...entry, stsUrl: 'https://${host}/trust' };
    const dev = { ...target, expand: (t: string) => t.replace('${host}', 'dev.test') };
    const prod = { ...target, expand: (t: string) => t.replace('${host}', 'prod.test') };
    expect(issuedCacheKey(withVars, dev)).not.toBe(issuedCacheKey(withVars, prod));
    await source.get(withVars, dev, deps);
    await source.get(withVars, prod, deps);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('retries after a failed request', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(token('2026-10-05T11:00:00Z'));
    const source = createIssuedTokenSource({ now: () => new Date('2026-10-05T10:00:00Z'), request });
    await expect(source.get(entry, target, deps)).rejects.toThrow('down');
    await expect(source.get(entry, target, deps)).resolves.toMatchObject({ assertionId: '_t1' });
    expect(source.peek(entry, target)).toBeDefined();
  });

  it('clear during a fetch leaves nothing cached, yet the caller gets its token', async () => {
    let release: (t: IssuedToken) => void = () => undefined;
    const request = vi.fn().mockReturnValue(new Promise<IssuedToken>((resolve) => (release = resolve)));
    const source = createIssuedTokenSource({ now: () => new Date('2026-10-05T10:00:00Z'), request });
    const pending = source.get(entry, target, deps);
    await Promise.resolve();
    source.clear(entry, target);
    release(token('2026-10-05T11:00:00Z'));
    await expect(pending).resolves.toMatchObject({ assertionId: '_t1' });
    expect(source.peek(entry, target)).toBeUndefined();
    expect(source.status(entry, target).state).toBe('none');
  });

  it('keys Kerberos credentials apart by domain', () => {
    const kerberos = (domain?: string): WssIssuedTokenEntry => ({
      ...entry,
      credential: { kind: 'kerberos', spn: 'host/sts.corp', ...(domain !== undefined ? { domain } : {}) },
    });
    expect(issuedCacheKey(kerberos('A'), target)).not.toBe(issuedCacheKey(kerberos('B'), target));
  });
});
