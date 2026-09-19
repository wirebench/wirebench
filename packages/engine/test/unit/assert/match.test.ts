import { describe, expect, it } from 'vitest';
import { evaluateAssertions } from '../../../src/assert/index.js';
import type { AssertionSubject } from '../../../src/assert/model.js';

const xml = '<m:list xmlns:m="urn:c"><m:c code="AT">Austria</m:c><m:c code="BE">Belgium</m:c></m:list>';
const soap: AssertionSubject = {
  protocol: 'soap',
  status: 200,
  durationMs: 1,
  bodyText: xml,
  bodyKind: 'xml',
  fault: { present: false },
};
const rest: AssertionSubject = {
  protocol: 'rest',
  status: 200,
  durationMs: 1,
  bodyText: '{"items":[{"id":7}],"ok":true}',
  bodyKind: 'json',
};
const ns = { m: 'urn:c' };

describe('match', () => {
  it('xpath equals a string, a number and a boolean', async () => {
    const results = await evaluateAssertions(soap, [
      { type: 'match', language: 'xpath', expression: 'string(//m:c[@code="AT"])', namespaces: ns, equals: 'Austria' },
      { type: 'match', language: 'xpath', expression: 'count(//m:c)', namespaces: ns, equals: 2 },
      { type: 'match', language: 'xpath', expression: 'count(//m:c) > 1', namespaces: ns, equals: true },
    ]);
    expect(results.map((r) => r.outcome)).toEqual(['passed', 'passed', 'passed']);
  });
  it('xquery and a regex', async () => {
    const [r] = await evaluateAssertions(soap, [
      {
        type: 'match',
        language: 'xquery',
        expression: 'string-join(for $c in //m:c return $c/@code, ",")',
        namespaces: ns,
        matches: '^AT,',
      },
    ]);
    expect(r!.outcome).toBe('passed');
  });
  it('exists true and false', async () => {
    const [yes, no] = await evaluateAssertions(soap, [
      { type: 'match', language: 'xpath', expression: '//m:c', namespaces: ns, exists: true },
      { type: 'match', language: 'xpath', expression: '//m:zz', namespaces: ns, exists: false },
    ]);
    expect([yes!.outcome, no!.outcome]).toEqual(['passed', 'passed']);
  });
  it('jsonpath on a JSON body', async () => {
    const [r] = await evaluateAssertions(rest, [
      { type: 'match', language: 'jsonpath', expression: '$.items[0].id', equals: 7 },
    ]);
    expect(r!.outcome).toBe('passed');
  });
  it('fails with expected and actual', async () => {
    const [r] = await evaluateAssertions(soap, [
      { type: 'match', language: 'xpath', expression: 'string(//m:c[1])', namespaces: ns, equals: 'Spain' },
    ]);
    expect(r).toMatchObject({ outcome: 'failed', expected: 'Spain', actual: 'Austria' });
  });
  it('errors on an expression that does not compile, and on jsonpath against XML', async () => {
    const [bad, wrong] = await evaluateAssertions(soap, [
      { type: 'match', language: 'xpath', expression: '//m:c[', namespaces: ns, exists: true },
      { type: 'match', language: 'jsonpath', expression: '$.a', exists: true },
    ]);
    expect([bad!.outcome, wrong!.outcome]).toEqual(['errored', 'errored']);
  });
});
