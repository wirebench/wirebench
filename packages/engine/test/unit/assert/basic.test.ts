import { describe, expect, it } from 'vitest';
import { evaluateAssertions } from '../../../src/assert/index.js';
import type { AssertionSubject } from '../../../src/assert/model.js';

const subject = (over: Partial<AssertionSubject> = {}): AssertionSubject => ({
  protocol: 'soap',
  status: 200,
  durationMs: 120,
  bodyText: '<a/>',
  bodyKind: 'xml',
  fault: { present: false },
  ...over,
});

describe('status', () => {
  it('passes on a listed code and on a class', async () => {
    const [a, b] = await evaluateAssertions(subject({ status: 201 }), [
      { type: 'status', equals: [200, 201] },
      { type: 'status', equals: '2xx' },
    ]);
    expect(a!.outcome).toBe('passed');
    expect(b!.outcome).toBe('passed');
  });
  it('fails with expected and actual', async () => {
    const [r] = await evaluateAssertions(subject({ status: 500 }), [{ type: 'status', equals: 200 }]);
    expect(r).toMatchObject({ outcome: 'failed', expected: '200', actual: '500', label: 'status is 200' });
  });
});

describe('soap-fault', () => {
  it('fails when a fault is present and none is expected, quoting the fault', async () => {
    const [r] = await evaluateAssertions(subject({ fault: { present: true, summary: 'soap:Server — boom' } }), [
      { type: 'soap-fault', expect: 'none' },
    ]);
    expect(r).toMatchObject({ outcome: 'failed', actual: 'soap:Server — boom' });
  });
  it('passes when a fault is expected and present', async () => {
    const [r] = await evaluateAssertions(subject({ fault: { present: true } }), [
      { type: 'soap-fault', expect: 'present' },
    ]);
    expect(r!.outcome).toBe('passed');
  });
  it('errors on a REST response, which cannot carry one', async () => {
    const rest: AssertionSubject = {
      protocol: 'rest',
      status: 200,
      durationMs: 120,
      bodyText: '<a/>',
      bodyKind: 'xml',
    };
    const [r] = await evaluateAssertions(rest, [{ type: 'soap-fault', expect: 'none' }]);
    expect(r!.outcome).toBe('errored');
  });
});

describe('sla', () => {
  it('passes at the ceiling and fails above it', async () => {
    const [ok] = await evaluateAssertions(subject({ durationMs: 800 }), [{ type: 'sla', maxMs: 800 }]);
    const [slow] = await evaluateAssertions(subject({ durationMs: 801 }), [{ type: 'sla', maxMs: 800 }]);
    expect(ok!.outcome).toBe('passed');
    expect(slow).toMatchObject({ outcome: 'failed', expected: '<= 800 ms', actual: '801 ms' });
  });
});

it('evaluates every assertion even after one fails, and uses name as the label', async () => {
  const results = await evaluateAssertions(subject({ status: 500 }), [
    { type: 'status', equals: 200, name: 'is OK' },
    { type: 'sla', maxMs: 1000 },
  ]);
  expect(results.map((r) => [r.label, r.outcome])).toEqual([
    ['is OK', 'failed'],
    ['responds within 1000 ms', 'passed'],
  ]);
});
