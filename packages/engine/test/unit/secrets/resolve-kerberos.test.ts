import { describe, expect, it } from 'vitest';
import { resolveAuthConfig, resolveSoapAuth } from '../../../src/secrets/resolve.js';
import { secretNeedsOfAuth } from '../../../src/secrets/env-names.js';

const secrets = (values: Record<string, string>) => (ref: string) => Promise.resolve(values[ref]);

describe('kerberos resolution', () => {
  it('maps the signed-in form with no secret at all', async () => {
    await expect(
      resolveAuthConfig({ type: 'kerberos', spn: 'HTTP/x', principal: 'a@R' }, secrets({})),
    ).resolves.toEqual({
      type: 'kerberos',
      spn: 'HTTP/x',
      principal: 'a@R',
    });
  });

  it('resolves the password only when a username is set', async () => {
    await expect(
      resolveAuthConfig({ type: 'kerberos', username: 'u', domain: 'D', passwordRef: 'r' }, secrets({ r: 'p' })),
    ).resolves.toEqual({ type: 'kerberos', username: 'u', domain: 'D', password: 'p' });
    await expect(resolveAuthConfig({ type: 'kerberos', passwordRef: 'r' }, secrets({}))).resolves.toEqual({
      type: 'kerberos',
    });
  });

  it('drops blank fields, and reads no password for a blank username', async () => {
    const read: string[] = [];
    const getSecret = (ref: string) => {
      read.push(ref);
      return Promise.resolve('p');
    };
    await expect(
      resolveAuthConfig(
        { type: 'kerberos', spn: '', principal: ' ', username: '  ', domain: '', passwordRef: 'r' },
        getSecret,
      ),
    ).resolves.toEqual({ type: 'kerberos' });
    expect(read).toEqual([]);
  });

  it('fails a dangling reference as secret-missing', async () => {
    await expect(
      resolveAuthConfig({ type: 'kerberos', username: 'u', passwordRef: 'gone' }, secrets({})),
    ).rejects.toMatchObject({ code: 'secret-missing' });
  });

  it('resolves for a SOAP owner too', async () => {
    await expect(resolveSoapAuth({ type: 'kerberos' }, secrets({}))).resolves.toEqual({ type: 'kerberos' });
  });

  it('names its environment-variable need only with a username', () => {
    expect(secretNeedsOfAuth({ type: 'kerberos' })).toEqual([]);
    expect(
      secretNeedsOfAuth({ type: 'kerberos', username: 'u', passwordRef: 'r', passwordEnv: 'KRB_PW' }),
    ).toHaveLength(1);
  });
});
