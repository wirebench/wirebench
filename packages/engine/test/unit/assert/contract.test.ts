import { describe, expect, it } from 'vitest';
import { evaluateAssertions } from '../../../src/assert/index.js';
import type { AssertionSubject } from '../../../src/assert/model.js';

const base: AssertionSubject = {
  protocol: 'soap',
  status: 200,
  durationMs: 1,
  bodyText: '<a/>',
  bodyKind: 'xml',
  fault: { present: false },
};

describe('schema', () => {
  it('passes when the contract reports nothing', async () => {
    const [r] = await evaluateAssertions({ ...base, validateContract: () => Promise.resolve([]) }, [
      { type: 'schema' },
    ]);
    expect(r).toMatchObject({ outcome: 'passed', label: 'response complies with the contract' });
  });
  it('fails quoting the first problem and the count', async () => {
    const problems = [{ message: "Element 'x': not expected." }, { message: 'second' }];
    const [r] = await evaluateAssertions({ ...base, validateContract: () => Promise.resolve(problems) }, [
      { type: 'schema' },
    ]);
    expect(r).toMatchObject({
      outcome: 'failed',
      expected: 'no problems',
      actual: "2 problems; first: Element 'x': not expected.",
    });
  });
  it('errors when there is no contract to validate against', async () => {
    const [r] = await evaluateAssertions(base, [{ type: 'schema' }]);
    expect(r!.outcome).toBe('errored');
  });
  it('errors on a REST request', async () => {
    const [r] = await evaluateAssertions(
      { protocol: 'rest', status: 200, durationMs: 1, bodyText: '{}', bodyKind: 'json' },
      [{ type: 'schema' }],
    );
    expect(r).toMatchObject({ outcome: 'errored', message: 'schema applies to a SOAP request only, for now' });
  });
});
