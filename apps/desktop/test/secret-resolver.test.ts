// @vitest-environment node
import { isWirebenchError } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { resolveEndpointAuth } from '../src/main/secret-resolver.js';

describe('resolveEndpointAuth', () => {
  it('returns undefined when there is no auth', async () => {
    expect(await resolveEndpointAuth(undefined, () => Promise.resolve(undefined))).toBeUndefined();
  });

  it('resolves a passwordRef to a password', async () => {
    const result = await resolveEndpointAuth(
      { type: 'basic', username: 'alice', passwordRef: 'sec_1', preemptive: true },
      (ref) => Promise.resolve(ref === 'sec_1' ? 's3cret!' : undefined),
    );
    expect(result).toEqual({ type: 'basic', username: 'alice', preemptive: true, password: 's3cret!' });
  });

  it('passes through auth with no passwordRef unchanged', async () => {
    const result = await resolveEndpointAuth({ type: 'basic', username: 'alice' }, () => Promise.resolve(undefined));
    expect(result).toEqual({ type: 'basic', username: 'alice' });
  });

  it('throws a secret-missing WirebenchError for a dangling ref', async () => {
    await expect(
      resolveEndpointAuth({ type: 'basic', passwordRef: 'sec_missing' }, () => Promise.resolve(undefined)),
    ).rejects.toSatisfy((error: unknown) => isWirebenchError(error) && error.code === 'secret-missing');
  });
});
