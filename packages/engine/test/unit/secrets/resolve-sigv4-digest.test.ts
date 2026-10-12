import { describe, expect, it } from 'vitest';
import { missingSecretRef } from '../../../src/http/auth/apply-auth.js';
import { envVariablesFor, secretNeedsOfAuth } from '../../../src/secrets/env-names.js';
import { resolveAuthConfig, resolveSoapAuth } from '../../../src/secrets/resolve.js';

const secrets = (values: Record<string, string>) => (ref: string) => Promise.resolve(values[ref]);
const SIGV4 = {
  type: 'aws-sigv4',
  region: 'us-east-1',
  service: 's3',
  accessKeyIdRef: 'a',
  secretAccessKeyRef: 'b',
} as const;
const SIGV4_NO_SECRET = {
  type: 'aws-sigv4',
  region: 'us-east-1',
  service: 's3',
  accessKeyIdRef: 'a',
} as const;

describe('aws-sigv4 resolution', () => {
  it('resolves the key pair, defaulting to a header signature', async () => {
    await expect(resolveAuthConfig(SIGV4, secrets({ a: 'AKID', b: 'SECRET' }))).resolves.toEqual({
      type: 'aws-sigv4',
      region: 'us-east-1',
      service: 's3',
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
      placement: 'header',
    });
  });

  it('adds the session token and the presign settings', async () => {
    await expect(
      resolveSoapAuth(
        { ...SIGV4, sessionTokenRef: 'c', placement: 'query', expiresSeconds: 60 },
        secrets({ a: 'AKID', b: 'SECRET', c: 'TOKEN' }),
      ),
    ).resolves.toMatchObject({ sessionToken: 'TOKEN', placement: 'query', expiresSeconds: 60 });
  });

  it('sends nothing until both keys are configured, and fails loudly on a dangling one', async () => {
    await expect(resolveAuthConfig(SIGV4_NO_SECRET, secrets({ a: 'AKID' }))).resolves.toBeUndefined();
    await expect(resolveAuthConfig(SIGV4, secrets({ a: 'AKID' }))).rejects.toMatchObject({ code: 'secret-missing' });
  });

  it('reports which key is missing', () => {
    expect(missingSecretRef({ ...SIGV4, accessKeyIdRef: '' })).toBe('accessKeyIdRef');
    expect(missingSecretRef(SIGV4_NO_SECRET)).toBe('secretAccessKeyRef');
    expect(missingSecretRef(SIGV4)).toBeUndefined();
  });

  it('lists all three secrets for CI, by their declared names', () => {
    const needs = secretNeedsOfAuth({ ...SIGV4, accessKeyIdEnv: 'AWS_KEY', sessionTokenRef: 'c' });
    expect(needs.map((need) => need.purpose)).toEqual([
      'AWS access key id',
      'AWS secret access key',
      'AWS session token',
    ]);
    expect(envVariablesFor(needs[0]!)[0]).toBe('WIREBENCH_SECRET_AWS_KEY');
  });
});

describe('digest resolution', () => {
  it('resolves the password', async () => {
    await expect(
      resolveAuthConfig({ type: 'digest', username: 'u', passwordRef: 'p' }, secrets({ p: 'pw' })),
    ).resolves.toEqual({ type: 'digest', username: 'u', password: 'pw' });
  });

  it('lists the password for CI', () => {
    expect(secretNeedsOfAuth({ type: 'digest', username: 'u', passwordRef: 'p', passwordEnv: 'DEV' })).toEqual([
      { ref: 'p', envName: 'DEV', purpose: 'digest password for "u"' },
    ]);
  });
});
