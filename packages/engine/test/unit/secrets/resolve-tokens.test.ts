import { describe, expect, it } from 'vitest';
import { resolveSecretTokens, secretTokenMissingMessage } from '../../../src/secrets/resolve.js';

describe('resolveSecretTokens', () => {
  it('resolves each name once through its secret: pseudo-ref', async () => {
    const seen: string[] = [];
    const values = await resolveSecretTokens(['a_key', 'b_key', 'a_key'], (ref) => {
      seen.push(ref);
      return Promise.resolve(`value-of-${ref}`);
    });
    expect(values).toEqual({ a_key: 'value-of-secret:a_key', b_key: 'value-of-secret:b_key' });
    expect(seen).toEqual(['secret:a_key', 'secret:b_key']);
  });

  it('throws secret-missing naming the secret when a value is absent', async () => {
    await expect(resolveSecretTokens(['billing_key'], () => Promise.resolve(undefined))).rejects.toMatchObject({
      code: 'secret-missing',
      message: secretTokenMissingMessage('billing_key'),
      details: { ref: 'secret:billing_key', name: 'billing_key' },
    });
    expect(secretTokenMissingMessage('billing_key')).toBe(
      'The secret "billing_key" is not on this machine — set it in Secrets.',
    );
  });
});
