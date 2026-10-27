// @vitest-environment node
/**
 * The tools/call Arguments editor's markers, answered in main (#79): valid arguments, a type
 * mismatch, a missing required property, text that is not JSON (with where the parse stopped), and
 * text a reference makes JSON only once expanded.
 */
import { describe, expect, it } from 'vitest';
import { mcpArgumentsCheck } from '../src/kinds/mcp/arguments-check.js';

const SCHEMA = {
  type: 'object',
  properties: { city: { type: 'string' }, days: { type: 'integer' } },
  required: ['city'],
};

describe('mcpArgumentsCheck', () => {
  it('finds nothing wrong with arguments that match the schema', () => {
    expect(mcpArgumentsCheck('{"city": "Vienna", "days": 3}', SCHEMA)).toEqual([]);
  });

  it('warns on a value of the wrong type, at its pointer', () => {
    expect(mcpArgumentsCheck('{"city": "Vienna", "days": "three"}', SCHEMA)).toEqual([
      expect.objectContaining({ severity: 'warning', pointer: '/days', keyword: 'type' }),
    ]);
  });

  it('warns on a missing required property, at the object', () => {
    expect(mcpArgumentsCheck('{"days": 3}', SCHEMA)).toEqual([
      { severity: 'warning', pointer: '', keyword: 'required', message: 'missing required property "city"' },
    ]);
  });

  it('checks blank text as the {} a send would send', () => {
    expect(mcpArgumentsCheck('  \n', SCHEMA)).toEqual([expect.objectContaining({ keyword: 'required' })]);
    expect(mcpArgumentsCheck('', undefined)).toEqual([]);
  });

  it('marks text that is not JSON as an error where the parse stopped', () => {
    const [problem, ...rest] = mcpArgumentsCheck('{\n  "city": "Vienna",\n  }', SCHEMA);
    expect(rest).toEqual([]);
    expect(problem).toMatchObject({ severity: 'error', pointer: '', position: { line: 3, column: 3 } });
    expect(problem?.message).toMatch(/^The arguments are not JSON: /);
    expect(problem?.message).not.toMatch(/position/);
  });

  it('places an unexpected end at the end of the text', () => {
    expect(mcpArgumentsCheck('{"city": ', SCHEMA)[0]).toMatchObject({
      severity: 'error',
      position: { line: 1, column: 9 },
    });
  });

  it('refuses a value that is not one object, as a send does', () => {
    expect(mcpArgumentsCheck('[1, 2]', SCHEMA)).toEqual([
      { severity: 'error', message: 'The arguments must be a JSON object', pointer: '' },
    ]);
  });

  it('says nothing of text a reference makes JSON only once a send expands it', () => {
    expect(mcpArgumentsCheck('{"city": "Vienna", "days": ${days}}', SCHEMA)).toEqual([]);
  });

  it('checks only the JSON when the tool has no schema in the catalogue', () => {
    expect(mcpArgumentsCheck('{"anything": true}', undefined)).toEqual([]);
  });
});
