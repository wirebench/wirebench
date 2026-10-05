import { describe, expect, it } from 'vitest';
import { mapOcAssertion } from '../../../../src/import/opencollection/assertions.js';
import type { OcAssertion } from '../../../../src/import/opencollection/model.js';

describe('mapOcAssertion', () => {
  it.each<[OcAssertion, unknown]>([
    [
      { expression: 'res.status', operator: 'eq', value: '200' },
      { type: 'status', equals: 200 },
    ],
    [
      { expression: 'res.body.name', operator: 'equals', value: 'Rex' },
      { type: 'match', language: 'jsonpath', expression: '$.name', equals: 'Rex' },
    ],
    [
      { expression: 'res.body.count', operator: 'eq', value: '3' },
      { type: 'match', language: 'jsonpath', expression: '$.count', equals: 3 },
    ],
    [
      { expression: 'res.body.ok', operator: 'eq', value: 'true' },
      { type: 'match', language: 'jsonpath', expression: '$.ok', equals: true },
    ],
    [
      { expression: 'res.body.items[0].id', operator: 'isNotNull' },
      { type: 'match', language: 'jsonpath', expression: '$.items[0].id', exists: true },
    ],
    [
      { expression: 'res.body.id', operator: 'isNotNull' },
      { type: 'match', language: 'jsonpath', expression: '$.id', exists: true },
    ],
    [
      { expression: 'res.body.gone', operator: 'isNull' },
      { type: 'match', language: 'jsonpath', expression: '$.gone', exists: false },
    ],
    [
      { expression: 'res.body.tags', operator: 'contains', value: 'a.b' },
      { type: 'match', language: 'jsonpath', expression: '$.tags', matches: 'a\\.b' },
    ],
    [
      { expression: 'res.responseTime', operator: 'lt', value: '500' },
      { type: 'sla', maxMs: 500 },
    ],
  ])('maps %o', (input, expected) => {
    expect(mapOcAssertion(input)).toEqual(expected);
  });

  it('returns undefined for what does not fit, or is disabled', () => {
    expect(mapOcAssertion({ expression: 'res.headers.x', operator: 'eq', value: '1' })).toBeUndefined();
    expect(mapOcAssertion({ expression: 'res.status', operator: 'eq', value: '200', disabled: true })).toBeUndefined();
    expect(mapOcAssertion({ expression: 'res.status', operator: 'neq', value: '500' })).toBeUndefined();
    expect(mapOcAssertion({ expression: 'res.body.n', operator: 'gt', value: '1' })).toBeUndefined();
    expect(mapOcAssertion({ expression: 'res.responseTime', operator: 'lt', value: 'soon' })).toBeUndefined();
  });

  it('reads a long body path in linear time', () => {
    const start = Date.now();
    expect(mapOcAssertion({ expression: `res.body.${'a.'.repeat(50_000)}!`, operator: 'isNull' })).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
