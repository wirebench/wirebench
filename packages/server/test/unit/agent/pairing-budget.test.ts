/** The failed-pairing budget is per tenant (hosted edition spec §19.8 guard 5, amending §18.2). */
import { describe, expect, it } from 'vitest';
import { AGENT_RATE_LIMITS, PairingBudget } from '../../../src/agent/routes.js';

describe('the failed-pairing budget', () => {
  it('50 failures in one tenant close its pairing and leave another tenant’s budget untouched', () => {
    let at = Date.parse('2026-10-31T12:00:00Z');
    const budget = new PairingBudget(() => new Date(at));
    expect(AGENT_RATE_LIMITS.pairFailures.capacity).toBe(50);
    for (let i = 0; i < 50; i++) {
      expect(budget.open('tenant-1').allowed).toBe(true);
      budget.failed('tenant-1');
    }
    expect(budget.open('tenant-1')).toMatchObject({ allowed: false });
    expect(budget.open('tenant-2')).toMatchObject({ allowed: true });
    for (let i = 0; i < 49; i++) budget.failed('tenant-2');
    expect(budget.open('tenant-2').allowed).toBe(true);
    // The window refills: ten minutes later tenant 1 may try again.
    at += AGENT_RATE_LIMITS.pairFailures.windowMs;
    expect(budget.open('tenant-1').allowed).toBe(true);
  });
});
