import { describe, expect, it } from 'vitest';
import { evaluateAssertions } from '../../../src/assert/index.js';
import type { AssertionSubject } from '../../../src/assert/model.js';

const subject: AssertionSubject = {
  protocol: 'rest',
  status: 201,
  durationMs: 3,
  bodyText: '{}',
  bodyKind: 'json',
  headers: [
    ['Content-Type', 'application/json; charset=utf-8'],
    ['Location', '/carts/42'],
    ['location', '/ignored-second'],
  ],
};

describe('header assertion', () => {
  it('matches the first value by a case-insensitive name', async () => {
    const results = await evaluateAssertions(subject, [
      { type: 'header', header: 'LOCATION', equals: '/carts/42' },
      { type: 'header', header: 'content-type', matches: '^application/json' },
      { type: 'header', header: 'X-Missing', exists: false },
      { type: 'header', header: 'Location', exists: true },
    ]);
    expect(results.map((r) => r.outcome)).toEqual(['passed', 'passed', 'passed', 'passed']);
  });

  it('fails with what it found', async () => {
    const [wrong, absent, present] = await evaluateAssertions(subject, [
      { type: 'header', header: 'Location', equals: '/carts/7' },
      { type: 'header', header: 'X-Missing', equals: 'a' },
      { type: 'header', header: 'Location', exists: false, name: 'no redirect' },
    ]);
    expect(wrong).toMatchObject({ outcome: 'failed', expected: '/carts/7', actual: '/carts/42' });
    expect(absent).toMatchObject({ outcome: 'failed', actual: 'absent' });
    expect(present).toMatchObject({ outcome: 'failed', label: 'no redirect', expected: 'absent', actual: 'present' });
  });

  it('treats a subject with no headers recorded as having none', async () => {
    const withoutHeaders: AssertionSubject = {
      protocol: 'rest',
      status: 200,
      durationMs: 1,
      bodyText: '',
      bodyKind: 'other',
    };
    const [result] = await evaluateAssertions(withoutHeaders, [{ type: 'header', header: 'Location', exists: false }]);
    expect(result?.outcome).toBe('passed');
  });

  it('is errored for a pattern that does not compile', async () => {
    const [result] = await evaluateAssertions(subject, [{ type: 'header', header: 'Location', matches: '(' }]);
    expect(result?.outcome).toBe('errored');
  });
});
