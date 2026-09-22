import { describe, expect, it } from 'vitest';
import { envVariablesFor, secretNeedsOfAuth } from '../../../src/secrets/env-names.js';

describe('secret needs', () => {
  it('lists a basic password with its declared name', () => {
    expect(
      secretNeedsOfAuth({ type: 'basic', username: 'svc', passwordRef: 'sec_1', passwordEnv: 'BILLING_PASSWORD' }),
    ).toEqual([{ ref: 'sec_1', envName: 'BILLING_PASSWORD', purpose: 'basic password for "svc"' }]);
  });

  it('lists nothing for inherit, none, or a scheme with no ref set', () => {
    expect(secretNeedsOfAuth(undefined)).toEqual([]);
    expect(secretNeedsOfAuth({ type: 'none' })).toEqual([]);
    expect(secretNeedsOfAuth({ type: 'bearer' })).toEqual([]);
  });

  it('looks the declared name up first, then the ref', () => {
    expect(envVariablesFor({ ref: 'sec_01j8-x', envName: 'API_TOKEN' })).toEqual([
      'WIREBENCH_SECRET_API_TOKEN',
      'WIREBENCH_SECRET_SEC_01J8_X',
    ]);
    expect(envVariablesFor({ ref: 'sec_1' })).toEqual(['WIREBENCH_SECRET_SEC_1']);
  });

  it('reads a ${secret:name} pseudo-ref from WIREBENCH_SECRET_<NAME> alone', () => {
    expect(envVariablesFor({ ref: 'secret:demo_basic', envName: 'DEMO_BASIC' })).toEqual([
      'WIREBENCH_SECRET_DEMO_BASIC',
    ]);
    expect(envVariablesFor({ ref: 'secret:demo_basic' })).toEqual(['WIREBENCH_SECRET_DEMO_BASIC']);
  });
});
