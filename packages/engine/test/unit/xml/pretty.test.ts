import { describe, expect, it } from 'vitest';
import { formatXml } from '../../../src/xml/pretty.js';

describe('formatXml', () => {
  it('re-indents a mangled SOAP envelope', () => {
    const input = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
<soapenv:Header/>
   <soapenv:Body>
<tem:Add><tem:intA>1</tem:intA>
        <tem:intB>2</tem:intB></tem:Add>
   </soapenv:Body>
</soapenv:Envelope>`;
    const result = formatXml(input);
    expect(result.problem).toBeUndefined();
    expect(result.changed).toBe(true);
    expect(result.text).toBe(
      [
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">',
        '   <soapenv:Header/>',
        '   <soapenv:Body>',
        '      <tem:Add>',
        '         <tem:intA>1</tem:intA>',
        '         <tem:intB>2</tem:intB>',
        '      </tem:Add>',
        '   </soapenv:Body>',
        '</soapenv:Envelope>',
      ].join('\n'),
    );
  });

  it('is idempotent: formatting an already-formatted document reports unchanged', () => {
    const once = formatXml('<a xmlns="urn:x"><b>1</b>\n<c>2</c></a>');
    const twice = formatXml(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.changed).toBe(false);
  });

  it('preserves comments, CDATA, processing instructions and the XML declaration', () => {
    const input =
      '<?xml version="1.0" encoding="UTF-8"?>\n<root>\n<!-- a comment -->\n<data><![CDATA[<raw> & stuff]]></data>\n<?pi target?>\n</root>';
    const result = formatXml(input);
    expect(result.problem).toBeUndefined();
    expect(result.text).toContain('<!-- a comment -->');
    expect(result.text).toContain('<![CDATA[<raw> & stuff]]>');
    expect(result.text).toContain('<?pi target?>');
    expect(result.text.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it('preserves attribute order, quoting and entity references', () => {
    const input = `<a z='1' a="2" m='&amp;&lt;'>text</a>`;
    const result = formatXml(input);
    expect(result.text).toBe(`<a z='1' a="2" m='&amp;&lt;'>text</a>`);
  });

  it('leaves mixed content untouched inside an element', () => {
    const input = '<p>Hello <b>world</b>!</p>';
    const result = formatXml(input);
    expect(result.text).toBe('<p>Hello <b>world</b>!</p>');
  });

  it('keeps a text-only element on one line', () => {
    const input = '<a>\n   \n  hello  \n</a>';
    const result = formatXml(input);
    expect(result.text).toBe('<a>hello</a>');
  });

  it('preserves self-closing tags', () => {
    const result = formatXml('<a><b/><c></c></a>');
    expect(result.text).toBe(['<a>', '   <b/>', '   <c></c>', '</a>'].join('\n'));
  });

  it('honours a custom indent unit', () => {
    const result = formatXml('<a><b>1</b></a>', { indent: '  ' });
    expect(result.text).toBe(['<a>', '  <b>1</b>', '</a>'].join('\n'));
  });

  it('reproduces preserveWhitespaceIn elements verbatim', () => {
    const input = '<doc><note>  keep   this    spacing  \n\n  as-is </note></doc>';
    const result = formatXml(input, { preserveWhitespaceIn: ['note'] });
    expect(result.text).toBe('<doc>\n   <note>  keep   this    spacing  \n\n  as-is </note>\n</doc>');
  });

  it('normalises CRLF line endings to LF', () => {
    const result = formatXml('<a>\r\n<b>1</b>\r\n</a>');
    expect(result.text).toBe(['<a>', '   <b>1</b>', '</a>'].join('\n'));
  });

  it('never throws and reports a problem on unbalanced tags, returning input unchanged', () => {
    const input = '<a><b></a>';
    const result = formatXml(input);
    expect(result.problem).toBeDefined();
    expect(result.changed).toBe(false);
    expect(result.text).toBe(input);
  });

  it('reports a problem on an unclosed tag', () => {
    const result = formatXml('<a><b>1</b>');
    expect(result.problem).toBeDefined();
    expect(result.text).toBe('<a><b>1</b>');
  });

  it('returns an empty string for empty input', () => {
    expect(formatXml('').text).toBe('');
  });

  it('does not break a tag on a > inside a double-quoted attribute value', () => {
    expect(formatXml('<a><b x="1>2"/></a>').text).toBe('<a>\n   <b x="1>2"/>\n</a>');
  });

  it('does not break a tag on a > inside a single-quoted attribute value', () => {
    expect(formatXml("<a><b x='1>2'/></a>").text).toBe("<a>\n   <b x='1>2'/>\n</a>");
  });

  it('handles a tag carrying both single- and double-quoted attributes', () => {
    expect(formatXml('<a><b x="1>2" y=\'3<4\'/></a>').text).toBe('<a>\n   <b x="1>2" y=\'3<4\'/>\n</a>');
  });
});
