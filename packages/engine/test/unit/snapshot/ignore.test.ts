import { describe, expect, it } from 'vitest';
import { matchesIgnoreRule, parseIgnoreRules } from '../../../src/snapshot/ignore.js';

describe('parseIgnoreRules', () => {
  it('splits one rule per line, skipping blanks and comments', () => {
    expect(parseIgnoreRules('/meta/timestamp\n\n# a comment\n//requestId\n  \n')).toEqual([
      '/meta/timestamp',
      '//requestId',
    ]);
  });

  it('trims whitespace around a rule', () => {
    expect(parseIgnoreRules('  /a/b  ')).toEqual(['/a/b']);
  });
});

describe('matchesIgnoreRule', () => {
  it('matches a "*" segment against any one segment', () => {
    expect(matchesIgnoreRule('/items/3/id', '/items/*/id')).toBe(true);
  });

  it('matches "//" against any depth', () => {
    expect(matchesIgnoreRule('/a/b/requestId', '//requestId')).toBe(true);
    expect(matchesIgnoreRule('/requestId', '//requestId')).toBe(true);
  });

  it('covers descendants of the named path', () => {
    expect(matchesIgnoreRule('/meta/timestamp/nested', '/meta/timestamp')).toBe(true);
  });

  it('matches a rule segment with no [n] against any index', () => {
    expect(matchesIgnoreRule('/Envelope/item[2]/@id', '/Envelope/item/@id')).toBe(true);
    expect(matchesIgnoreRule('/Envelope/item[3]', '/Envelope/item')).toBe(true);
  });

  it('does not match an unrelated path', () => {
    expect(matchesIgnoreRule('/other/path', '/meta/timestamp')).toBe(false);
  });

  it('does not match a shorter path than the rule', () => {
    expect(matchesIgnoreRule('/meta', '/meta/timestamp')).toBe(false);
  });
});
