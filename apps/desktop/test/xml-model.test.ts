import { describe, expect, it } from 'vitest';
import {
  applyValueEdit,
  escapeXmlAttr,
  escapeXmlText,
  parseXmlOutline,
} from '../src/renderer/features/request-editor/views/xml-model.js';

const TEM = 'http://tempuri.org/';
const SOAPENV = 'http://schemas.xmlsoap.org/soap/envelope/';

const CALCULATOR_ENVELOPE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">' +
  '<soapenv:Header/>' +
  '<soapenv:Body>' +
  '<tem:Add>' +
  '<tem:intA>1</tem:intA>' +
  '<tem:intB>2</tem:intB>' +
  '</tem:Add>' +
  '</soapenv:Body>' +
  '</soapenv:Envelope>';

describe('parseXmlOutline', () => {
  it('builds the Envelope > Body > Add > intA tree with resolved namespaces', () => {
    const { root, problems } = parseXmlOutline(CALCULATOR_ENVELOPE);
    expect(problems).toEqual([]);
    expect(root).toBeDefined();

    const envelope = root as NonNullable<typeof root>;
    expect(envelope.name).toBe('soapenv:Envelope');
    expect(envelope.namespaceUri).toBe(SOAPENV);
    expect(envelope.children).toHaveLength(2);

    const header = envelope.children[0] as NonNullable<typeof root>;
    expect(header.name).toBe('soapenv:Header');
    expect(header.selfClosing).toBe(true);

    const body = envelope.children[1] as NonNullable<typeof root>;
    expect(body.name).toBe('soapenv:Body');
    expect(body.namespaceUri).toBe(SOAPENV);

    const add = body.children[0] as NonNullable<typeof root>;
    expect(add.name).toBe('tem:Add');
    expect(add.namespaceUri).toBe(TEM);
    expect(add.children).toHaveLength(2);

    const intA = add.children[0] as NonNullable<typeof root>;
    expect(intA.name).toBe('tem:intA');
    expect(intA.namespaceUri).toBe(TEM);
    expect(intA.children).toHaveLength(0);
    expect(intA.text).toBeDefined();
    expect(intA.text?.value).toBe('1');
    expect(CALCULATOR_ENVELOPE.slice(intA.text?.range.start, intA.text?.range.end)).toBe('1');

    // Stable path-based ids.
    expect(envelope.id).toBe('0');
    expect(body.id).toBe('0/1');
    expect(add.id).toBe('0/1/0');
    expect(intA.id).toBe('0/1/0/0');
  });

  it('reports exact ranges for the whole element and its name', () => {
    const text = '<foo>bar</foo>';
    const { root } = parseXmlOutline(text);
    const foo = root as NonNullable<typeof root>;
    expect(text.slice(foo.range.start, foo.range.end)).toBe('<foo>bar</foo>');
    expect(text.slice(foo.nameRange.start, foo.nameRange.end)).toBe('foo');
  });

  it('parses attributes with value ranges inside the quotes', () => {
    const text = '<foo id="42" name=\'bar\'/>';
    const { root } = parseXmlOutline(text);
    const foo = root as NonNullable<typeof root>;
    expect(foo.attributes).toHaveLength(2);
    const id = foo.attributes[0] as NonNullable<(typeof foo.attributes)[number]>;
    expect(id.name).toBe('id');
    expect(id.value).toBe('42');
    expect(text.slice(id.valueRange.start, id.valueRange.end)).toBe('42');
    const nameAttr = foo.attributes[1] as NonNullable<(typeof foo.attributes)[number]>;
    expect(nameAttr.value).toBe('bar');
    expect(text.slice(nameAttr.valueRange.start, nameAttr.valueRange.end)).toBe('bar');
  });

  it('treats a CDATA section as text with a range covering only the payload', () => {
    const text = '<foo><![CDATA[<raw>&stuff]]></foo>';
    const { root } = parseXmlOutline(text);
    const foo = root as NonNullable<typeof root>;
    expect(foo.text?.value).toBe('<raw>&stuff');
    expect(text.slice(foo.text?.range.start, foo.text?.range.end)).toBe('<raw>&stuff');
  });

  it('counts comments but excludes them from text content', () => {
    const text = '<foo>a<!-- note -->b</foo>';
    const { root } = parseXmlOutline(text);
    const foo = root as NonNullable<typeof root>;
    expect(foo.comments).toBe(1);
    expect(foo.text?.value).toBe('ab');
  });

  it('treats an empty element as text-only with an empty value', () => {
    const text = '<foo></foo>';
    const { root } = parseXmlOutline(text);
    const foo = root as NonNullable<typeof root>;
    expect(foo.text?.value).toBe('');
    expect(foo.text?.range.start).toBe(foo.text?.range.end);
  });

  it('gives mixed/child-element content children instead of text', () => {
    const text = '<foo><bar/></foo>';
    const { root } = parseXmlOutline(text);
    const foo = root as NonNullable<typeof root>;
    expect(foo.text).toBeUndefined();
    expect(foo.children).toHaveLength(1);
  });

  it('decodes entity references in text and attribute values', () => {
    const text = '<foo a="1 &amp; 2">x &lt; y</foo>';
    const { root } = parseXmlOutline(text);
    const foo = root as NonNullable<typeof root>;
    expect(foo.attributes[0]?.value).toBe('1 & 2');
    expect(foo.text?.value).toBe('x < y');
  });

  it('is tolerant of malformed input: reports a problem and still returns a best-effort tree', () => {
    const text = '<foo><bar>unterminated';
    const { root, problems } = parseXmlOutline(text);
    expect(problems.length).toBeGreaterThan(0);
    expect(root).toBeDefined();
    expect(root?.name).toBe('foo');
  });
});

describe('applyValueEdit', () => {
  it('replaces only the given range, leaving the rest of the document untouched', () => {
    const text = '<foo>old</foo>';
    const range = { start: 5, end: 8 };
    expect(text.slice(range.start, range.end)).toBe('old');
    const result = applyValueEdit(text, range, 'new');
    expect(result).toBe('<foo>new</foo>');
  });

  it('escapes & and < in element text content', () => {
    const text = '<foo>old</foo>';
    const result = applyValueEdit(text, { start: 5, end: 8 }, 'a & b < c');
    expect(result).toBe('<foo>a &amp; b &lt; c</foo>');
  });

  it('escapes & < and the surrounding quote character in attribute values', () => {
    const text = '<foo a="old"/>';
    const range = { start: 8, end: 11 };
    expect(text.slice(range.start, range.end)).toBe('old');
    const result = applyValueEdit(text, range, 'a & "b" < c');
    expect(result).toBe('<foo a="a &amp; &quot;b&quot; &lt; c"/>');
  });

  it('respects a single-quoted attribute, escaping apostrophes instead', () => {
    const text = "<foo a='old'/>";
    const result = applyValueEdit(text, { start: 8, end: 11 }, "it's");
    expect(result).toBe("<foo a='it&apos;s'/>");
  });
});

describe('escape helpers', () => {
  it('escapeXmlText escapes & and <', () => {
    expect(escapeXmlText('a & b < c')).toBe('a &amp; b &lt; c');
  });

  it('escapeXmlAttr escapes the quote character in addition to & and <', () => {
    expect(escapeXmlAttr('a "b"', '"')).toBe('a &quot;b&quot;');
    expect(escapeXmlAttr("a 'b'", "'")).toBe('a &apos;b&apos;');
  });
});
