import { describe, expect, it } from 'vitest';
import { createEnvSecrets } from '../../src/env-secrets.js';

const needs = [{ ref: 'sec_demo', envName: 'DEMO_PASSWORD', purpose: 'x' }];

describe('createEnvSecrets', () => {
  it('prefers the declared name, then the ref', async () => {
    const both = createEnvSecrets(needs, {
      WIREBENCH_SECRET_DEMO_PASSWORD: 'named',
      WIREBENCH_SECRET_SEC_DEMO: 'byref',
    });
    expect(await both.getSecret('sec_demo')).toBe('named');
    const refOnly = createEnvSecrets(needs, { WIREBENCH_SECRET_SEC_DEMO: 'byref' });
    expect(await refOnly.getSecret('sec_demo')).toBe('byref');
  });
  it('treats unset and empty as missing', async () => {
    expect(await createEnvSecrets(needs, {}).getSecret('sec_demo')).toBeUndefined();
    expect(await createEnvSecrets(needs, { WIREBENCH_SECRET_DEMO_PASSWORD: '' }).getSecret('sec_demo')).toBeUndefined();
  });
  it('resolves a ref nobody declared, by its ref-derived variable', async () => {
    expect(await createEnvSecrets([], { WIREBENCH_SECRET_SEC_OTHER: 'v' }).getSecret('sec_other')).toBe('v');
  });
  it('remembers only what it handed out', async () => {
    const secrets = createEnvSecrets(needs, { WIREBENCH_SECRET_DEMO_PASSWORD: 'named', UNRELATED: 'zzz' });
    expect(secrets.values()).toEqual([]);
    await secrets.getSecret('sec_demo');
    expect(secrets.values()).toEqual(['named']);
  });
});
