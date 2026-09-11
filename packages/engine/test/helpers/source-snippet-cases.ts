/**
 * Shared test cases for the two `sourceSnippet` implementations that intentionally exist —
 * `packages/engine/src/wsdl/docs-generator.ts` (used by Generate Documentation) and
 * `apps/desktop/src/renderer/features/interface-editor/source-snippet.ts` (used by the Schema
 * tab). They are not the same function: the renderer's has no parser or `fs` access and must
 * stay pure JS with no engine dependency, while the engine's is one detail of `generateDocs`.
 * Both walk the same "find the element starting on this line, match its closing tag, dedent"
 * shape, though, so this fixture keeps their observable behaviour honest without importing one
 * from the other — the renderer must not pull in `@wirebench/engine`'s main entry (it drags in
 * Node built-ins the sandboxed renderer cannot load; see `docs-generator.ts` and
 * `source-snippet.ts` for the cross-reference on each side).
 */

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

/** One case both `sourceSnippet` implementations must agree on. */
export interface SourceSnippetCase {
  readonly name: string;
  readonly text: string;
  readonly line: number;
  readonly maxLines?: number;
  readonly expected: string;
}

export const SOURCE_SNIPPET_CASES: readonly SourceSnippetCase[] = [
  {
    name: 'the whole declaration, counting same-named nested elements',
    text: XSD,
    line: 2,
    expected: [
      '<xs:element name="Add">',
      '  <xs:complexType>',
      '    <xs:sequence>',
      '      <xs:element name="intA" type="xs:int"/>',
      '    </xs:sequence>',
      '  </xs:complexType>',
      '</xs:element>',
    ].join('\n'),
  },
  {
    name: 'a self-closing declaration on its own',
    text: XSD,
    line: 5,
    expected: '<xs:element name="intA" type="xs:int"/>',
  },
  {
    name: 'a long declaration capped at maxLines',
    text: XSD,
    line: 2,
    maxLines: 2,
    expected: '<xs:element name="Add">\n  <xs:complexType>\n…',
  },
];
