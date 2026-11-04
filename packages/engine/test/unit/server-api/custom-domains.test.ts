import { describe, expect, it } from 'vitest';
import {
  CUSTOM_DOMAIN_NAME_MAX_LENGTH,
  CUSTOM_DOMAIN_STATES,
  customDomainClaimRequestSchema,
  customDomainResponseSchema,
  customDomainSchema,
} from '../../../src/index.js';

const CLAIM = {
  name: 'app.customer.test',
  state: 'pending',
  records: [
    { type: 'CNAME', name: 'app.customer.test', value: 'custom.app.test' },
    { type: 'TXT', name: '_wirebench.app.customer.test', value: 'wirebench-domain-verification=abc' },
  ],
  lastResult: null,
  checkedAt: null,
};

describe('custom-domain wire shapes (hosted edition spec §23.6)', () => {
  it('a claim carries its name, state, two records, last result and check time', () => {
    expect(customDomainSchema.parse(CLAIM)).toEqual(CLAIM);
    const checked = {
      ...CLAIM,
      state: 'verified',
      lastResult: { cname: 'ok', txt: 'ok', certificate: 'missing', message: 'Waiting for the certificate.' },
      checkedAt: '2026-11-04T10:00:00.000Z',
    };
    expect(customDomainSchema.parse(checked)).toEqual(checked);
  });

  it('refuses an unknown state or record type', () => {
    expect(customDomainSchema.safeParse({ ...CLAIM, state: 'held' }).success).toBe(false);
    expect(
      customDomainSchema.safeParse({ ...CLAIM, records: [{ type: 'A', name: 'x.test', value: '192.0.2.1' }] }).success,
    ).toBe(false);
  });

  it('GET answers the claim, or {} when there is none', () => {
    expect(customDomainResponseSchema.parse({})).toEqual({});
    expect(customDomainResponseSchema.parse(CLAIM)).toEqual(CLAIM);
  });

  it('the claim request is one bounded name', () => {
    expect(customDomainClaimRequestSchema.parse({ name: 'app.customer.test' })).toEqual({ name: 'app.customer.test' });
    expect(customDomainClaimRequestSchema.safeParse({}).success).toBe(false);
    expect(
      customDomainClaimRequestSchema.safeParse({ name: 'a'.repeat(CUSTOM_DOMAIN_NAME_MAX_LENGTH + 1) }).success,
    ).toBe(false);
  });

  it('names the seven states of §23.2', () => {
    expect(CUSTOM_DOMAIN_STATES).toEqual(['pending', 'verified', 'active', 'failing', 'lapsed', 'paused', 'expired']);
  });
});
