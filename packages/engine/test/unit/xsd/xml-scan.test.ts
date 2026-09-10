import { describe, expect, it } from 'vitest';
import { scanXml } from '../../../src/xsd/xml-scan.js';

describe('scanXml', () => {
  it('records exact ranges for text and attribute values', () => {
    const xml = '<a id="7">hi</a>';
    const { elements } = scanXml(xml);
    const root = elements[0];
    expect(root?.name).toBe('a');
    expect(root?.range).toEqual({ start: 0, end: xml.length });
    expect(xml.slice(root?.text?.range.start, root?.text?.range.end)).toBe('hi');
    expect(xml.slice(root?.attributes[0]?.valueRange.start, root?.attributes[0]?.valueRange.end)).toBe('7');
  });

  it('decodes entities and reads single-quoted attributes', () => {
    const { elements } = scanXml("<a b='x&amp;y'>1 &lt; 2 &#65; &#x42; &nope;</a>");
    expect(elements[0]?.attributes[0]?.value).toBe('x&y');
    expect(elements[0]?.text?.value).toBe('1 < 2 A B &nope;');
  });

  it('gives a self-closing element no text range at all', () => {
    const { elements } = scanXml('<a/>');
    expect(elements[0]?.selfClosing).toBe(true);
    expect(elements[0]?.text).toBeUndefined();
  });

  it('resolves prefixes from inherited scope as well as its own declarations', () => {
    const { elements } = scanXml('<tem:a><b/></tem:a>', { tem: 'urn:t', '': 'urn:d' });
    expect(elements[0]?.namespaceUri).toBe('urn:t');
    expect(elements[0]?.children[0]?.namespaceUri).toBe('urn:d');
    const own = scanXml('<a xmlns="urn:o" xml:lang="en"/>');
    expect(own.elements[0]?.namespaceUri).toBe('urn:o');
    expect(scanXml('<xml:a/>').elements[0]?.namespaceUri).toBe('http://www.w3.org/XML/1998/namespace');
  });

  it('attaches comments to the element that follows them, and the rest to the parent', () => {
    const { elements } = scanXml('<a><!--lead--><b/><!--tail--></a>');
    expect(elements[0]?.children[0]?.leadingComments).toEqual(['lead']);
    expect(elements[0]?.trailingComments).toEqual(['tail']);
  });

  it('keeps CDATA payloads and skips declarations and processing instructions', () => {
    const { elements } = scanXml('<?xml version="1.0"?><!DOCTYPE a><a><![CDATA[<raw>]]></a>');
    expect(elements[0]?.text?.value).toBe('<raw>');
  });

  it('is tolerant of malformed input rather than throwing', () => {
    expect(scanXml('<a><!-- never ends').problems[0]).toContain('Unterminated comment');
    expect(scanXml('<a><![CDATA[oops').problems[0]).toContain('Unterminated CDATA');
    expect(scanXml('<?pi never ends').problems[0]).toContain('Unterminated declaration');
    expect(scanXml('<a></a></b>').problems[0]).toContain('Unexpected closing tag');
    expect(scanXml('<a></a').problems[0]).toContain('Unterminated closing tag');
    expect(scanXml('< >').problems[0]).toContain('Malformed tag');
    const unclosed = scanXml('<a><b>x');
    expect(unclosed.problems[0]).toContain('unclosed element');
    expect(unclosed.elements[0]?.range.end).toBe('<a><b>x'.length);
  });

  it('reports several top-level elements in order', () => {
    const { elements } = scanXml('<a/><!--between--><b/>');
    expect(elements.map((e) => e.name)).toEqual(['a', 'b']);
    expect(elements[1]?.leadingComments).toEqual(['between']);
  });
});
