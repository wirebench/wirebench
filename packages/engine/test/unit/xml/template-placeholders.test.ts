import { describe, expect, it } from 'vitest';
import { findTemplatePlaceholders } from '../../../src/xml/template-placeholders.js';

describe('findTemplatePlaceholders (#728)', () => {
  it('finds elements and attributes whose whole value is "?", with positions', () => {
    const xml = [
      '<soapenv:Envelope xmlns:soapenv="urn:s" xmlns:tem="urn:t">',
      '  <soapenv:Body>',
      '    <tem:Add unit="?">',
      '      <tem:intA>?</tem:intA>',
      '      <tem:intB>4</tem:intB>',
      '      <tem:note> ? </tem:note>',
      '    </tem:Add>',
      '  </soapenv:Body>',
      '</soapenv:Envelope>',
    ].join('\n');
    expect(findTemplatePlaceholders(xml)).toEqual([
      { name: '@unit', line: 3, column: 20 },
      { name: 'tem:intA', line: 4, column: 17 },
      { name: 'tem:note', line: 6, column: 18 },
    ]);
  });

  it('ignores a "?" inside other text, comments and CDATA', () => {
    const xml = '<a><b>why?</b><!-- <c>?</c> --><d><![CDATA[<e>?</e>]]></d><f>a="?"</f><g>??</g></a>';
    expect(findTemplatePlaceholders(xml)).toEqual([]);
  });
});

describe('findTemplatePlaceholders on hostile input', () => {
  it('stays linear on many unclosed comments and CDATA openers', () => {
    const hostile = '<!--'.repeat(50_000) + '<![CDATA['.repeat(50_000);
    const started = performance.now();
    expect(findTemplatePlaceholders(hostile)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
