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

  describe('the escaped forms a secret takes in a body', () => {
    const secret = `p&ss<1 "q'\\x~`;
    const mask = createSecretMasker([secret]);

    it('masks the three-entity XML form a SOAP envelope or wsse:Password carries', () => {
      expect(mask(`<wsse:Password>p&amp;ss&lt;1 "q'\\x~</wsse:Password>`)).toBe(
        '<wsse:Password><redacted></wsse:Password>',
      );
    });

    it('masks the five-entity XML form an escaped REST XML body carries', () => {
      expect(mask('<pw>p&amp;ss&lt;1 &quot;q&apos;\\x~</pw>')).toBe('<pw><redacted></pw>');
    });

    it('masks the JSON-string form a JSON body carries', () => {
      expect(mask(`{"pw":"p&ss<1 \\"q'\\\\x~"}`)).toBe('{"pw":"<redacted>"}');
    });

    it("masks the form-encoded body's form and URLSearchParams' form", () => {
      expect(mask('pw=p%26ss%3C1+%22q%27%5Cx~&a=1')).toBe('pw=<redacted>&a=1');
      expect(mask('pw=p%26ss%3C1+%22q%27%5Cx%7E&a=1')).toBe('pw=<redacted>&a=1');
    });

    it('keeps the length floor: a short value is not masked in any form', () => {
      expect(createSecretMasker(['a&b'])('a&amp;b a%26b')).toBe('a&amp;b a%26b');
    });
  });

  it('ignores empty and very short values rather than shredding the text', () => {
    const mask = createSecretMasker(['', 'ab']);
    expect(mask('abab')).toBe('abab');
  });
});
