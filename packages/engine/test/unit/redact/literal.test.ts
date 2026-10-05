import { describe, expect, it } from 'vitest';
import { createSecretMasker } from '../../../src/redact/literal.js';
import { diffSnapshot } from '../../../src/snapshot/diff.js';
import { truncateValue } from '../../../src/snapshot/format.js';

describe('createSecretMasker', () => {
  it('masks every occurrence of every value', () => {
    const mask = createSecretMasker(['s3cret', 'tok-123']);
    expect(mask('a=s3cret&b=tok-123&c=s3cret')).toBe('a=<redacted>&b=<redacted>&c=<redacted>');
  });

  it('masks the longer value first so a shared prefix does not leave a tail', () => {
    const mask = createSecretMasker(['abcd', 'abcdefgh']);
    expect(mask('x abcdefgh y')).toBe('x <redacted> y');
  });

  it('masks two overlapping secrets as one range', () => {
    const mask = createSecretMasker(['abc-token', 'token-xyz']);
    expect(mask('x abc-token-xyz y')).toBe('x <redacted> y');
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

  describe('a secret cut short by a report cap', () => {
    const secret = 's3cret-value-0042';
    const mask = createSecretMasker([secret]);

    it('masks the prefix a truncateValue cut leaves', () => {
      const cut = truncateValue('x'.repeat(190) + secret);
      expect(cut).toContain('s3cret-va…');
      const masked = mask(cut);
      expect(masked).toBe(`${'x'.repeat(190)}<redacted>…`);
    });

    it('masks the cut prefix in diffSnapshot values for JSON, an XML attribute and a text body', () => {
      const quoted = 'ab"cd-efgh-1234';
      const maskQuoted = createSecretMasker([quoted]);
      const pad = 'x'.repeat(190);
      const json = diffSnapshot(JSON.stringify({ v: pad + quoted }), JSON.stringify({ v: 'other' }), {
        format: 'json',
        ignore: [],
      });
      const xml = diffSnapshot(`<r a="${pad}${secret}"/>`, '<r a="other"/>', { format: 'xml', ignore: [] });
      const text = diffSnapshot(pad + secret, 'other', { format: 'text', ignore: [] });
      expect(json.changes[0]?.expected).toContain('ab\\"cd-e…');
      expect(maskQuoted(json.changes[0]?.expected ?? '')).toBe(`"${pad}<redacted>…`);
      expect(mask(xml.changes[0]?.expected ?? '')).toBe(`${pad}<redacted>…`);
      expect(mask(text.changes[0]?.expected ?? '')).toBe(`${pad}<redacted>…`);
    });

    it('masks a prefix before the exchange cap and one split by a byte cap', () => {
      expect(mask('body s3cret\n… truncated')).toBe('body <redacted>\n… truncated');
      expect(mask('body s3cr\uFFFD\uFFFD\n… truncated')).toBe('body <redacted>\uFFFD\uFFFD\n… truncated');
      expect(mask('body s3c\uFFFD…')).toBe('body <redacted>\uFFFD…');
    });

    it('masks a prefix before the closing quote of a callback actual', () => {
      expect(mask('"token=s3cret-v…"')).toBe('"token=<redacted>…"');
    });

    it('masks a cut Basic credential whole', () => {
      expect(mask('Authorization: Basic dXNlcjpw…')).toBe('Authorization: Basic <redacted>…');
    });

    it('leaves text before a cut that matches no needle prefix', () => {
      expect(mask('nothing secret here…')).toBe('nothing secret here…');
    });

    it('masks a whole needle followed by a cut once', () => {
      expect(mask(`a ${secret}…`)).toBe('a <redacted>…');
    });

    it('masks a cut secret whole when a shorter secret starts it', () => {
      const overlapping = createSecretMasker(['token', 'token-abcdef-123456']);
      expect(overlapping('Authorization: token-abcdef-12…')).toBe('Authorization: <redacted>…');
    });

    it('masks a cut password that starts with the username', () => {
      const credentials = createSecretMasker(['admin', 'admin-s3cret-99']);
      expect(credentials('login admin with admin-s3cr…')).toBe('login <redacted> with <redacted>…');
    });

    it('leaves a needle prefix that no cut follows', () => {
      expect(mask('a s3cret-va b')).toBe('a s3cret-va b');
      expect(mask('a s3cret-va')).toBe('a s3cret-va');
    });
  });
});

describe('createSecretMasker with a marker', () => {
  it('writes the given marker in place of each value, the default otherwise', () => {
    expect(createSecretMasker(['s3cret-value'], { marker: '&lt;redacted&gt;' })('<a>s3cret-value</a>')).toBe(
      '<a>&lt;redacted&gt;</a>',
    );
    expect(createSecretMasker(['s3cret-value'])('<a>s3cret-value</a>')).toBe('<a><redacted></a>');
  });
});
