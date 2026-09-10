import { describe, expect, it } from 'vitest';
import { entitizeValue, prettyPrint, removeEmptyContent, stripWhitespaces } from '../../../src/soap/transforms.js';

const ENVELOPE = (body: string): string =>
  `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">\n` +
  `  <soapenv:Header/>\n` +
  `  <soapenv:Body>\n${body}\n  </soapenv:Body>\n</soapenv:Envelope>`;

describe('removeEmptyContent', () => {
  it('drops elements whose content is empty', () => {
    const xml = ENVELOPE('    <tem:Add><tem:intA>1</tem:intA><tem:intB></tem:intB></tem:Add>');
    const out = removeEmptyContent(xml);
    expect(out).toContain('<tem:intA>1</tem:intA>');
    expect(out).not.toContain('intB');
  });

  it('drops elements whose content is only a `?` placeholder', () => {
    const out = removeEmptyContent(ENVELOPE('    <a><b>?</b><c>kept</c></a>'));
    expect(out).not.toContain('<b>');
    expect(out).toContain('<c>kept</c>');
  });

  it('keeps an empty element that carries attributes', () => {
    const out = removeEmptyContent(ENVELOPE('    <a><b xsi:nil="true"/></a>'));
    expect(out).toContain('<b xsi:nil="true"/>');
  });

  it('collapses nested empties, removing the parent once every child has gone', () => {
    const out = removeEmptyContent(ENVELOPE('    <a><b><c>?</c><d/></b><e>x</e></a>'));
    expect(out).not.toContain('<b>');
    expect(out).toContain('<e>x</e>');
    expect(out).toContain('<a>');
  });

  it('never touches the Envelope, Header or Body wrappers', () => {
    const out = removeEmptyContent(ENVELOPE('    <a/>'));
    expect(out).toContain('<soapenv:Envelope');
    expect(out).toContain('<soapenv:Header/>');
    expect(out).toContain('<soapenv:Body>');
  });

  it('keeps an element whose content is a CDATA section', () => {
    const out = removeEmptyContent(ENVELOPE('    <a><![CDATA[  ]]></a>'));
    expect(out).toContain('CDATA');
  });

  it('returns the input unchanged for malformed markup', () => {
    expect(removeEmptyContent('<a><b></a>')).toBe('<a><b></a>');
  });
});

describe('stripWhitespaces', () => {
  it('removes whitespace-only text between elements and trims text nodes', () => {
    const out = stripWhitespaces('<a>\n  <b>  hi  </b>\n</a>');
    expect(out).toBe('<a><b>hi</b></a>');
  });

  it('keeps CDATA content verbatim', () => {
    const out = stripWhitespaces('<a>\n  <b><![CDATA[  keep me  ]]></b>\n</a>');
    expect(out).toBe('<a><b><![CDATA[  keep me  ]]></b></a>');
  });

  it('returns the input unchanged for malformed markup', () => {
    expect(stripWhitespaces('<a><<')).toBe('<a><<');
  });
});

describe('prettyPrint', () => {
  it('indents with the requested width', () => {
    const out = prettyPrint('<a><b>1</b></a>', 2);
    expect(out).toBe('<a>\n  <b>1</b>\n</a>');
  });

  it('returns the input when it cannot be formatted', () => {
    expect(prettyPrint('<a><b></a>')).toBe('<a><b></a>');
  });
});

describe('entitizeValue', () => {
  it('escapes the XML markup characters', () => {
    expect(entitizeValue('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });
});
