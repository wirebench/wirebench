import { describe, expect, it } from 'vitest';
import { secretRefsInValue } from '../../../src/secrets/secret-refs.js';

describe('secretRefsInValue', () => {
  it('finds every keychain reference anywhere in a model, once each, and nothing else', () => {
    const model = {
      auth: { type: 'basic', passwordRef: 'sec_0123456789abcdef0123456789' },
      apis: [{ auth: { tokenRef: 'sec_fedcba9876543210fedcba9876' } }, { note: 'sec_0123456789abcdef0123456789' }],
      name: 'sec_', // too short
      other: 'Sec_0123456789abcdef0123456789',
    };
    expect(secretRefsInValue(model).sort()).toEqual(
      ['sec_0123456789abcdef0123456789', 'sec_fedcba9876543210fedcba9876'].sort(),
    );
  });
});
