// The buckets themselves run against the shared table: test/integration/operations/limiters-moved.test.ts.
import { describe, expect, it } from 'vitest';
import { catchBucketKey } from '../../../src/hooks/rate-limit.js';

describe('catch URL bucket keys (hosted edition spec §19.8 guard 5)', () => {
  it('lead with the tenant, so one catch URL id in two tenants never shares a bucket', () => {
    const one = '00000000-0000-4000-8000-000000000001';
    const two = '00000000-0000-4000-8000-000000000002';
    const hook = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
    expect(catchBucketKey(one, hook)).toBe(`${one}:${hook}`);
    expect(catchBucketKey(one, hook)).not.toBe(catchBucketKey(two, hook));
  });
});
