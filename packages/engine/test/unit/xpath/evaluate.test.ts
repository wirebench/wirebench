import { describe, expect, it } from 'vitest';
import { evaluate } from '../../../src/xpath/evaluate.js';

const TEM = 'http://tempuri.org/';
const ADD_RESPONSE =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">\n' +
  '  <soapenv:Body>\n' +
  '    <tem:AddResponse>\n' +
  '      <tem:AddResult>3</tem:AddResult>\n' +
  '    </tem:AddResponse>\n' +
  '  </soapenv:Body>\n' +
  '</soapenv:Envelope>';

describe('evaluate (XPath 3.1)', () => {
  it('resolves a namespaced text() path to a value', () => {
    const result = evaluate(ADD_RESPONSE, '//tem:AddResult/text()', { language: 'xpath', namespaces: { tem: TEM } });
    expect(result.kind).toBe('nodes');
    if (result.kind !== 'nodes') throw new Error('expected nodes');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.text).toBe('3');
    expect(result.items[0]?.nodeKind).toBe('text');
  });

  it('a node result carries a range that matches the original text', () => {
    const result = evaluate(ADD_RESPONSE, '//tem:AddResult', { language: 'xpath', namespaces: { tem: TEM } });
    expect(result.kind).toBe('nodes');
    if (result.kind !== 'nodes') throw new Error('expected nodes');
    const item = result.items[0];
    expect(item).toBeDefined();
    expect(item?.range).toBeDefined();
    if (item?.range === undefined) throw new Error('expected range');
    expect(ADD_RESPONSE.slice(item.range.start, item.range.start + '<tem:AddResult>'.length)).toBe('<tem:AddResult>');
  });

  it('reports a simple path for a node result', () => {
    const result = evaluate(ADD_RESPONSE, '//tem:AddResult', { language: 'xpath', namespaces: { tem: TEM } });
    expect(result.kind).toBe('nodes');
    if (result.kind !== 'nodes') throw new Error('expected nodes');
    expect(result.items[0]?.path).toBe('/soapenv:Envelope[1]/soapenv:Body[1]/tem:AddResponse[1]/tem:AddResult[1]');
  });

  it('count() returns a single numeric value', () => {
    const result = evaluate(ADD_RESPONSE, 'count(//*)', { language: 'xpath' });
    expect(result.kind).toBe('values');
    if (result.kind !== 'values') throw new Error('expected values');
    expect(result.items).toEqual([{ text: '4', type: 'xs:integer' }]);
  });

  it('evaluates a map constructor and lookup', () => {
    const result = evaluate(ADD_RESPONSE, "map{'a': 1}?a", { language: 'xpath' });
    expect(result.kind).toBe('values');
    if (result.kind !== 'values') throw new Error('expected values');
    expect(result.items[0]?.text).toBe('1');
  });

  it('reports a map value with the map type label', () => {
    const result = evaluate(ADD_RESPONSE, "map{'a': 1, 'b': 2}", { language: 'xpath' });
    expect(result.kind).toBe('values');
    if (result.kind !== 'values') throw new Error('expected values');
    expect(result.items[0]?.type).toBe('map');
    expect(result.items[0]?.text).toBe('{"a":1,"b":2}');
  });

  it('reports a boolean value with the xs:boolean type label', () => {
    const result = evaluate(ADD_RESPONSE, 'exists(//tem:AddResult)', { language: 'xpath', namespaces: { tem: TEM } });
    expect(result.kind).toBe('values');
    if (result.kind !== 'values') throw new Error('expected values');
    expect(result.items).toEqual([{ text: 'true', type: 'xs:boolean' }]);
  });

  it('evaluates an array constructor as a single array value', () => {
    const result = evaluate(ADD_RESPONSE, 'array{1,2}', { language: 'xpath' });
    expect(result.kind).toBe('values');
    if (result.kind !== 'values') throw new Error('expected values');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.type).toBe('array');
    expect(result.items[0]?.text).toBe('[1,2]');
  });

  it('string-join concatenates string results', () => {
    const result = evaluate(ADD_RESPONSE, "string-join(('a', 'b', 'c'), '-')", { language: 'xpath' });
    expect(result.kind).toBe('values');
    if (result.kind !== 'values') throw new Error('expected values');
    expect(result.items).toEqual([{ text: 'a-b-c', type: 'xs:string' }]);
  });

  it('resolves an attribute result', () => {
    const xml = '<root id="42"><child/></root>';
    const result = evaluate(xml, '//@id', { language: 'xpath' });
    expect(result.kind).toBe('nodes');
    if (result.kind !== 'nodes') throw new Error('expected nodes');
    expect(result.items[0]).toMatchObject({ text: '42', nodeKind: 'attribute', path: '/root[1]/@id' });
  });

  it('an empty result set reports kind empty', () => {
    const result = evaluate(ADD_RESPONSE, '//nonexistent', { language: 'xpath', namespaces: { tem: TEM } });
    expect(result).toEqual({ kind: 'empty' });
  });

  it('a syntax error reports a message and, when available, a position', () => {
    const result = evaluate(ADD_RESPONSE, '//[', { language: 'xpath' });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('expected error');
    expect(result.message).toContain('XPST0003');
    expect(result.code).toBe('XPST0003');
  });

  it('an unresolvable namespace prefix reports an error', () => {
    const result = evaluate(ADD_RESPONSE, '//unbound:Foo', { language: 'xpath' });
    expect(result.kind).toBe('error');
  });

  it('caps very large result sets and reports truncation', () => {
    const xml = `<root>${'<item/>'.repeat(1_500)}</root>`;
    const result = evaluate(xml, '//item', { language: 'xpath' });
    expect(result.kind).toBe('nodes');
    if (result.kind !== 'nodes') throw new Error('expected nodes');
    expect(result.items).toHaveLength(1_000);
    expect(result.truncated).toBe(true);
  });

  it('a malformed document reports a parse error instead of throwing', () => {
    const result = evaluate('<not-closed>', '/*', { language: 'xpath' });
    expect(result.kind).toBe('error');
  });
});

describe('evaluate (XQuery 3.1)', () => {
  it('runs a FLWOR expression over every element', () => {
    const result = evaluate(ADD_RESPONSE, 'for $x in //* return local-name($x)', { language: 'xquery' });
    expect(result.kind).toBe('values');
    if (result.kind !== 'values') throw new Error('expected values');
    expect(result.items.map((item) => item.text)).toEqual(['Envelope', 'Body', 'AddResponse', 'AddResult']);
  });

  it('runs a let-bound FLWOR expression', () => {
    const result = evaluate(ADD_RESPONSE, 'let $n := count(//*) return $n * 2', { language: 'xquery' });
    expect(result.kind).toBe('values');
    if (result.kind !== 'values') throw new Error('expected values');
    expect(result.items).toEqual([{ text: '8', type: 'xs:integer' }]);
  });

  it('runs a direct element constructor', () => {
    const result = evaluate('<a><b>1</b></a>', '<r>{//b/text()}</r>', { language: 'xquery' });
    expect(result.kind).toBe('nodes');
    if (result.kind !== 'nodes') throw new Error('expected nodes');
    expect(result.items[0]?.text).toBe('<r>1</r>');
  });
});
