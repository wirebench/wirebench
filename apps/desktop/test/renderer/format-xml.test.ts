import { describe, expect, it } from 'vitest';
import { formatXml } from '../../src/renderer/lib/format-xml.js';

describe('formatXml', () => {
  it('indents nested elements', () => {
    expect(formatXml('<a><b><c/></b></a>')).toBe('<a>\n   <b>\n      <c/>\n   </b>\n</a>');
  });

  it('keeps a text-only element on one line', () => {
    expect(formatXml('<a><b>hello</b></a>')).toBe('<a>\n   <b>hello</b>\n</a>');
  });

  it('preserves text exactly, including entities', () => {
    expect(formatXml('<a>a &amp; b</a>')).toBe('<a>a &amp; b</a>');
  });

  it('keeps self-closing tags self-closing', () => {
    expect(formatXml('<a><b /></a>')).toBe('<a>\n   <b />\n</a>');
  });

  it('places the XML declaration on its own line', () => {
    expect(formatXml('<?xml version="1.0"?><a><b/></a>')).toBe('<?xml version="1.0"?>\n<a>\n   <b/>\n</a>');
  });

  it('indents comments like elements', () => {
    expect(formatXml('<a><!-- note --><b/></a>')).toBe('<a>\n   <!-- note -->\n   <b/>\n</a>');
  });

  it('passes CDATA through untouched', () => {
    expect(formatXml('<a><![CDATA[ <b>  raw ]]></a>')).toBe('<a><![CDATA[ <b>  raw ]]></a>');
  });

  it('re-indents already-formatted input idempotently', () => {
    const once = formatXml('<a>\n  <b>x</b>\n</a>');
    expect(formatXml(once)).toBe(once);
  });

  it('honours the indent option', () => {
    expect(formatXml('<a><b/></a>', { indent: 2 })).toBe('<a>\n  <b/>\n</a>');
  });

  it('returns the input unchanged when it has no markup', () => {
    expect(formatXml('not xml at all')).toBe('not xml at all');
  });

  it('returns the input unchanged when tags are unbalanced', () => {
    expect(formatXml('<a><b></a>')).toBe('<a><b></a>');
  });

  it('returns an empty string for empty input', () => {
    expect(formatXml('')).toBe('');
  });

  it('keeps mixed content on one line', () => {
    expect(formatXml('<a>text <b>bold</b> tail</a>')).toBe('<a>text <b>bold</b> tail</a>');
  });

  it('does not break a tag on a > inside a double-quoted attribute value', () => {
    expect(formatXml('<a><b x="1>2"/></a>')).toBe('<a>\n   <b x="1>2"/>\n</a>');
  });

  it('does not break a tag on a > inside a single-quoted attribute value', () => {
    expect(formatXml("<a><b x='1>2'/></a>")).toBe("<a>\n   <b x='1>2'/>\n</a>");
  });

  it('handles a tag carrying both single- and double-quoted attributes', () => {
    expect(formatXml('<a><b x="1>2" y=\'3<4\'/></a>')).toBe('<a>\n   <b x="1>2" y=\'3<4\'/>\n</a>');
  });
});
