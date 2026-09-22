// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isWirebenchError } from '../../../src/errors.js';
import { resolveEndpointAuth, resolveSoapAuth } from '../../../src/secrets/resolve.js';

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

  it('secret-missing names the username when one is known', async () => {
    await expect(
      resolveEndpointAuth({ type: 'basic', username: 'alice', passwordRef: 'sec_missing' }, () =>
        Promise.resolve(undefined),
      ),
    ).rejects.toMatchObject({
      code: 'secret-missing',
      message: 'The password for "alice" is not on this machine — enter it in the authentication settings.',
      details: { ref: 'sec_missing' },
    });
  });

  it('secret-missing falls back to a generic message with no username', async () => {
    await expect(
      resolveEndpointAuth({ type: 'basic', passwordRef: 'sec_missing' }, () => Promise.resolve(undefined)),
    ).rejects.toMatchObject({
      code: 'secret-missing',
      message: 'A saved password is not on this machine — enter it in the authentication settings.',
      details: { ref: 'sec_missing' },
    });
  });
});

describe('resolveSoapAuth', () => {
  const getSecret = (ref: string): Promise<string | undefined> => Promise.resolve(ref === 'sec_1' ? 'tok' : undefined);

  it('returns undefined when there is no owner auth', async () => {
    expect(await resolveSoapAuth(undefined, getSecret)).toBeUndefined();
  });

  it('resolves basic the same way toSendAuth(resolveEndpointAuth(...)) does', async () => {
    const result = await resolveSoapAuth({ type: 'basic', username: 'svc', passwordRef: 'sec_1' }, () =>
      Promise.resolve('s3cret!'),
    );
    expect(result).toEqual({ type: 'basic', username: 'svc', password: 's3cret!', preemptive: true });
  });

  it('basic with a username and no password resolves to undefined, as today', async () => {
    expect(await resolveSoapAuth({ type: 'basic', username: 'svc' }, getSecret)).toBeUndefined();
  });

  it('resolves NTLM unchanged', async () => {
    const result = await resolveSoapAuth({ type: 'ntlm', username: 'svc', passwordRef: 'sec_1', domain: 'CORP' }, () =>
      Promise.resolve('s3cret!'),
    );
    expect(result).toEqual({ type: 'ntlm', username: 'svc', password: 's3cret!', domain: 'CORP' });
  });

  it('resolves a bearer tokenRef to a bearer SendAuth', async () => {
    const result = await resolveSoapAuth({ type: 'bearer', tokenRef: 'sec_1' }, getSecret);
    expect(result).toEqual({ type: 'bearer', token: 'tok' });
  });

  it('throws secret-missing for a dangling bearer tokenRef', async () => {
    await expect(resolveSoapAuth({ type: 'bearer', tokenRef: 'sec_missing' }, getSecret)).rejects.toSatisfy(
      (error: unknown) => isWirebenchError(error) && error.code === 'secret-missing',
    );
  });

  it('resolves to undefined when a bearer owner has no tokenRef', async () => {
    expect(await resolveSoapAuth({ type: 'bearer' }, getSecret)).toBeUndefined();
  });

  it('resolves an api-key valueRef', async () => {
    const result = await resolveSoapAuth(
      { type: 'api-key', name: 'X-Api-Key', in: 'header', valueRef: 'sec_1' },
      getSecret,
    );
    expect(result).toEqual({ type: 'api-key', name: 'X-Api-Key', in: 'header', value: 'tok' });
  });

  it('resolves oauth2 with an accessToken and to undefined without one', async () => {
    const oauth = {
      type: 'oauth2' as const,
      grant: 'client-credentials' as const,
      tokenUrl: 'https://auth.test/token',
      clientId: 'c',
      scopes: [],
      clientAuth: 'basic' as const,
      pkce: true,
    };
    expect(await resolveSoapAuth(oauth, getSecret, { accessToken: 'at' })).toEqual({
      type: 'oauth2',
      accessToken: 'at',
    });
    expect(await resolveSoapAuth(oauth, getSecret)).toBeUndefined();
  });
});
