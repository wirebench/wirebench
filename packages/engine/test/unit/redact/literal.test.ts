import { describe, expect, it } from 'vitest';
import { createSecretMasker } from '../../../src/redact/literal.js';

describe('createSecretMasker', () => {
  it('masks every occurrence of every value', () => {
    const mask = createSecretMasker(['s3cret', 'tok-123']);
    expect(mask('a=s3cret&b=tok-123&c=s3cret')).toBe('a=<redacted>&b=<redacted>&c=<redacted>');
  });

  it('masks the longer value first so a shared prefix does not leave a tail', () => {
    const mask = createSecretMasker(['abcd', 'abcdefgh']);
    expect(mask('x abcdefgh y')).toBe('x <redacted> y');
  });

  it('masks the base64 and percent-encoded forms a header or URL would carry', () => {
    const mask = createSecretMasker(['p@ss word']);
    const basic = Buffer.from('user:p@ss word').toString('base64');
    expect(mask(`Authorization: Basic ${basic}`)).not.toContain(basic);
    expect(mask('?pw=p%40ss%20word')).toBe('?pw=<redacted>');
  });

  it('ignores empty and very short values rather than shredding the text', () => {
    const mask = createSecretMasker(['', 'ab']);
    expect(mask('abab')).toBe('abab');
  });
});
