import { describe, expect, it, vi } from 'vitest';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { sourceSnippet } from '../../src/renderer/features/interface-editor/source-snippet.js';
import { documentLabel } from '../../src/renderer/features/interface-editor/wsdl-content-tab.js';

const XSD = [
  '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">',
  '  <xs:element name="Add">',
  '    <xs:complexType>',
  '      <xs:sequence>',
  '        <xs:element name="intA" type="xs:int"/>',
  '      </xs:sequence>',
  '    </xs:complexType>',
  '  </xs:element>',
  '</xs:schema>',
].join('\n');

describe('sourceSnippet', () => {
  it('returns the whole declaration, counting same-named nested elements', () => {
    expect(sourceSnippet(XSD, 2)).toBe(
      [
        '<xs:element name="Add">',
        '  <xs:complexType>',
        '    <xs:sequence>',
        '      <xs:element name="intA" type="xs:int"/>',
        '    </xs:sequence>',
        '  </xs:complexType>',
        '</xs:element>',
      ].join('\n'),
    );
  });

  it('stops at a self-closing declaration', () => {
    expect(sourceSnippet(XSD, 5)).toBe('<xs:element name="intA" type="xs:int"/>');
  });

  it('caps long declarations', () => {
    expect(sourceSnippet(XSD, 2, 2)).toBe('<xs:element name="Add">\n  <xs:complexType>\n…');
  });

  it('is empty without a line', () => {
    expect(sourceSnippet(XSD, undefined)).toBe('');
  });
});

describe('documentLabel', () => {
  it('uses the last path segment', () => {
    expect(documentLabel('https://example.test/a/b/calc.wsdl?wsdl')).toBe('calc.wsdl');
  });

  it('falls back to the whole location', () => {
    expect(documentLabel('inline')).toBe('inline');
  });
});
