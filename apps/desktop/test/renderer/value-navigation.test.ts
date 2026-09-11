import { describe, expect, it } from 'vitest';
import { nextValueRange, valueRanges } from '../../src/renderer/features/request-editor/value-navigation.js';

const ENVELOPE = [
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">',
  '  <soapenv:Header/>',
  '  <soapenv:Body>',
  '    <tem:Add id="7">',
  '      <tem:intA>?</tem:intA>',
  '      <tem:intB>12</tem:intB>',
  '    </tem:Add>',
  '  </soapenv:Body>',
  '</soapenv:Envelope>',
].join('\n');

const valueAt = (range: { start: number; end: number }): string => ENVELOPE.slice(range.start, range.end);

describe('valueRanges', () => {
  it('returns leaf values and attribute values in document order', () => {
    const ranges = valueRanges(ENVELOPE);

    expect(ranges.map(valueAt)).toEqual(['', '7', '?', '12']);
  });

  it('skips namespace declarations', () => {
    expect(valueRanges(ENVELOPE).map(valueAt)).not.toContain('http://tempuri.org/');
  });

  it('returns nothing for text with no parseable root', () => {
    expect(valueRanges('   ')).toEqual([]);
  });

  it('gives a container element no range of its own', () => {
    // `soapenv:Body` has element children, so only its descendants are steppable.
    const bodyStart = ENVELOPE.indexOf('<soapenv:Body>');
    const ranges = valueRanges(ENVELOPE).filter((range) => range.start > bodyStart);

    expect(ranges.map(valueAt)).toEqual(['7', '?', '12']);
  });
});

describe('nextValueRange', () => {
  const ranges = valueRanges(ENVELOPE);

  it('steps forward to the value after the caret', () => {
    const from = ENVELOPE.indexOf('?');

    expect(valueAt(nextValueRange(ranges, from, 'next') as { start: number; end: number })).toBe('12');
  });

  it('steps backward to the value before the caret', () => {
    const from = ENVELOPE.indexOf('12');

    expect(valueAt(nextValueRange(ranges, from, 'previous') as { start: number; end: number })).toBe('?');
  });

  it('wraps past the last value', () => {
    expect(valueAt(nextValueRange(ranges, ENVELOPE.length, 'next') as { start: number; end: number })).toBe('');
  });

  it('wraps before the first value', () => {
    expect(valueAt(nextValueRange(ranges, 0, 'previous') as { start: number; end: number })).toBe('12');
  });

  it('returns undefined with no ranges at all', () => {
    expect(nextValueRange([], 0, 'next')).toBeUndefined();
  });
});
