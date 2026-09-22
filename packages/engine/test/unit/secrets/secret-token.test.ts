import { describe, expect, it } from 'vitest';
import {
  parseSecretPseudoRef,
  SECRET_NAME_PATTERN,
  secretEnvName,
  secretPseudoRef,
  secretToken,
} from '../../../src/secrets/secret-token.js';

describe('SECRET_NAME_PATTERN', () => {
  it.each(['billing_key', '_x', 'A1'])('accepts %s', (name) => {
    expect(SECRET_NAME_PATTERN.test(name)).toBe(true);
  });

  it.each(['1x', 'has-dash', 'has space', ''])('rejects %s', (name) => {
    expect(SECRET_NAME_PATTERN.test(name)).toBe(false);
  });
});

describe('secretToken', () => {
  it('produces the ${secret:name} literal', () => {
    expect(secretToken('billing_key')).toBe('${secret:billing_key}');
  });
});

describe('secretPseudoRef / parseSecretPseudoRef', () => {
  it('round-trips a name through the pseudo-ref', () => {
    expect(secretPseudoRef('billing_key')).toBe('secret:billing_key');
    expect(parseSecretPseudoRef('secret:billing_key')).toBe('billing_key');
  });

  it('returns undefined for a ref that is not a secret pseudo-ref', () => {
    expect(parseSecretPseudoRef('sec_1')).toBeUndefined();
    expect(parseSecretPseudoRef('')).toBeUndefined();
  });
});

describe('secretEnvName', () => {
  it('upper-cases the name', () => {
    expect(secretEnvName('billing_key')).toBe('BILLING_KEY');
    expect(secretEnvName('Already_UP')).toBe('ALREADY_UP');
  });
});
