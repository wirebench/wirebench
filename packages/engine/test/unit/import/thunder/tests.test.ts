import { describe, expect, it } from 'vitest';
import type { TcTest } from '../../../../src/import/thunder/model.js';
import { assertionOfThunderTest, describeThunderTest } from '../../../../src/import/thunder/tests.js';

const row = (type: string, action: string, value: string, custom = ''): TcTest => ({ type, custom, action, value });

describe('assertionOfThunderTest', () => {
  it('maps a status code equal to a status assertion', () => {
    expect(assertionOfThunderTest(row('res-code', 'equal', '201'))).toEqual({ type: 'status', equals: 201 });
    expect(assertionOfThunderTest(row('res-code', 'notequal', '201'))).toBeUndefined();
    expect(assertionOfThunderTest(row('res-code', 'equal', '2xx'))).toBeUndefined();
  });

  it('maps a response time under a limit to an SLA', () => {
    expect(assertionOfThunderTest(row('res-time', '<', '800'))).toEqual({ type: 'sla', maxMs: 800 });
    expect(assertionOfThunderTest(row('res-time', '<=', '800'))).toEqual({ type: 'sla', maxMs: 800 });
    expect(assertionOfThunderTest(row('res-time', '>', '800'))).toBeUndefined();
  });

  it('maps a JSON query equal to a JSONPath match, the value read as its type', () => {
    expect(assertionOfThunderTest(row('json-query', 'equal', '7', 'json.items[0].id'))).toEqual({
      type: 'match',
      language: 'jsonpath',
      expression: '$.items[0].id',
      equals: 7,
    });
    expect(assertionOfThunderTest(row('json-query', 'equal', 'true', 'json.ok'))).toMatchObject({ equals: true });
    expect(assertionOfThunderTest(row('json-query', 'equal', 'abc', 'json.name'))).toMatchObject({ equals: 'abc' });
  });

  it('maps a JSON query contains to a match on the escaped text', () => {
    expect(assertionOfThunderTest(row('json-query', 'contains', 'a.b(c)', 'json.name'))).toEqual({
      type: 'match',
      language: 'jsonpath',
      expression: '$.name',
      matches: 'a\\.b\\(c\\)',
    });
  });

  it('leaves out a query that is not a plain path, and every other row', () => {
    expect(assertionOfThunderTest(row('json-query', 'equal', '1', 'json.items.length'))).toMatchObject({
      expression: '$.items.length',
    });
    expect(assertionOfThunderTest(row('json-query', 'equal', '1', 'json.a | first'))).toBeUndefined();
    expect(assertionOfThunderTest(row('json-query', 'istype', 'string', 'json.id'))).toBeUndefined();
    expect(assertionOfThunderTest(row('Content-Type', 'contains', 'json'))).toBeUndefined();
    expect(assertionOfThunderTest(row('set-env-var', 'setto', '{{x}}', 'json.id'))).toBeUndefined();
  });

  it('reads a long query that does not match in linear time', () => {
    const custom = `json${'.a'.repeat(20_000)}!`;
    const started = performance.now();
    expect(assertionOfThunderTest(row('json-query', 'equal', '1', custom))).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('describeThunderTest', () => {
  it('names a row by its non-empty parts', () => {
    expect(describeThunderTest(row('res-code', 'equal', '200'))).toBe('res-code equal 200');
    expect(describeThunderTest(row('json-query', 'istype', 'string', 'json.id'))).toBe(
      'json-query json.id istype string',
    );
  });
});
