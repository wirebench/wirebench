/**
 * The root's wrap (hosted edition spec §19.7, ADR-0036): a tenant's data key is sealed under a key derived from the
 * root and bound to the tenant id, so a wrapped key opens only for its own tenant and only under its own root.
 */
import { describe, expect, it } from 'vitest';
import { environmentKeyRoot, newDataKey } from '../../../src/tenancy/keys.js';

const ROOT = Buffer.alloc(32, 0x41);
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

describe('the environment key root', () => {
  it('a wrapped key opens for its tenant, and not for another or under another root', async () => {
    const root = environmentKeyRoot(ROOT);
    const dataKey = newDataKey();
    const wrapped = await root.wrap(A, dataKey);
    expect(await root.unwrap(A, wrapped)).toEqual(dataKey);
    await expect(root.unwrap(B, wrapped)).rejects.toMatchObject({ code: 'tenancy-data-key-refused' });
    await expect(environmentKeyRoot(Buffer.alloc(32, 0x42)).unwrap(A, wrapped)).rejects.toMatchObject({
      code: 'tenancy-data-key-refused',
    });
  });

  it('never holds the key in the clear, and seals the same key differently each time', async () => {
    const root = environmentKeyRoot(ROOT);
    const dataKey = newDataKey();
    const one = await root.wrap(A, dataKey);
    const two = await root.wrap(A, dataKey);
    expect(one.includes(dataKey)).toBe(false);
    expect(one.toString('latin1')).not.toContain(dataKey.toString('base64'));
    expect(one.equals(two)).toBe(false);
  });

  it('refuses a damaged wrap, and its message names neither key', async () => {
    const root = environmentKeyRoot(ROOT);
    const dataKey = newDataKey();
    const wrapped = await root.wrap(A, dataKey);
    const damaged = Buffer.from(wrapped);
    damaged[damaged.length - 1]! ^= 1;
    const error = await root.unwrap(A, damaged).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error).toMatchObject({ code: 'tenancy-data-key-refused' });
    for (const secret of [dataKey, ROOT, wrapped]) {
      expect(error!.message).not.toContain(secret.toString('base64'));
      expect(error!.message).not.toContain(secret.toString('hex'));
    }
  });

  it('refuses a root that is not 32 bytes, and a data key that is not', async () => {
    expect(() => environmentKeyRoot(Buffer.alloc(16))).toThrow('32 bytes');
    await expect(environmentKeyRoot(ROOT).wrap(A, Buffer.alloc(16))).rejects.toThrow('32 bytes');
  });

  it('refuses a tenant id that is not a lower-case UUID as the derivation input (Task 23 review M1)', async () => {
    const root = environmentKeyRoot(ROOT);
    const wrapped = await root.wrap(A, newDataKey());
    for (const id of [A.toUpperCase(), `{${A}}`, A.replaceAll('-', ''), '', 'default']) {
      await expect(root.wrap(id, newDataKey())).rejects.toMatchObject({ code: 'tenancy-tenant-id-invalid' });
      await expect(root.unwrap(id, wrapped)).rejects.toMatchObject({ code: 'tenancy-tenant-id-invalid' });
    }
  });

  it('makes 32 random bytes for each data key', () => {
    const one = newDataKey();
    expect(one).toHaveLength(32);
    expect(one.equals(newDataKey())).toBe(false);
  });
});
