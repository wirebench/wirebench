/**
 * How a recorded body is shown. A history entry stores text, whichever protocol produced it, so the
 * viewer sniffs what it is looking at — and never rewrites text that does not parse, because the
 * entry is a record of what actually crossed the wire.
 */
import { describe, expect, it } from 'vitest';
import { prettyPrintBody, sniffLanguage } from '../../src/renderer/features/history/history-format.js';

describe('sniffLanguage', () => {
  it('recognises JSON by its opening brace or bracket', () => {
    expect(sniffLanguage('{"a":1}')).toBe('json');
    expect(sniffLanguage('  [1,2] ')).toBe('json');
  });

  it('recognises XML by its opening angle bracket', () => {
    expect(sniffLanguage('<Envelope/>')).toBe('xml');
  });

  it('falls back to plain text for anything else, including an empty body', () => {
    expect(sniffLanguage('id=7&name=a')).toBe('text');
    expect(sniffLanguage('')).toBe('text');
  });
});

describe('prettyPrintBody', () => {
  it('reformats JSON', () => {
    expect(prettyPrintBody('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it('reformats XML', () => {
    expect(prettyPrintBody('<a><b/></a>')).toContain('\n');
  });

  it('leaves text that does not parse exactly as it was recorded', () => {
    expect(prettyPrintBody('{"a":')).toBe('{"a":');
    expect(prettyPrintBody('<a><b></a>')).toBe('<a><b></a>');
    expect(prettyPrintBody('plain')).toBe('plain');
  });
});
