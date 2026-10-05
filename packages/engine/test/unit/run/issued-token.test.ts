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
    expect(source.status(entry, target)).toMatchObject({ state: 'none' });
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
});
