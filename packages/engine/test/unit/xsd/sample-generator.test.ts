import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseXml } from '../../../src/xml/parse.js';
import { createDefaultFetchDocument } from '../../../src/wsdl/fetch.js';
import { resolveDefinition } from '../../../src/wsdl/resolver.js';
import { buildSchemaSet } from '../../../src/xsd/schema-set.js';
import type { SchemaSet } from '../../../src/xsd/schema-set.js';
import { generateElement, generateSoapEncArray, generateType } from '../../../src/xsd/sample-generator.js';
import type { GenerateOptions } from '../../../src/xsd/sample-generator.js';
import { PLACEHOLDER, sampleValueFor, typeCommentFor } from '../../../src/xsd/sample-values.js';
import { fileUrl, fixtureUrl, readPublicFixture } from '../../helpers/fixtures.js';

const goldenDir = fileURLToPath(new URL('../../fixtures/samples/', import.meta.url));

const TNS = 'urn:wb:sc';
const OTHER = 'urn:wb:sc:other';
const XSD = 'http://www.w3.org/2001/XMLSchema';

const q = (ns: string, local: string) => ({ namespaceUri: ns, localName: local });

/** Builds a schema set from a bare `xs:schema` document. */
function schemaSetFromXml(xml: string): SchemaSet {
  const root = parseXml(xml, { location: 'inline.xsd' }).documentElement;
  if (root === null) {
    throw new Error('no document element');
  }
  return buildSchemaSet({ schemaElements: [root] });
}

async function schemaSetFromWsdlText(text: string, location: string): Promise<SchemaSet> {
  const bundle = await resolveDefinition({ location, text }, { fetchDocument: createDefaultFetchDocument() });
  return buildSchemaSet(bundle);
}

let set: SchemaSet;

beforeAll(async () => {
  const bundle = await resolveDefinition(
    { location: fixtureUrl('wsdl/crafted/schema-constructs/service.wsdl') },
    { fetchDocument: createDefaultFetchDocument() },
  );
  set = buildSchemaSet(bundle);
});

/** Compares against a committed golden; `WIREBENCH_UPDATE_GOLDENS=1` rewrites it. */
function expectGolden(name: string, actual: string): void {
  const file = `${goldenDir}${name}.xml`;
  if (process.env.WIREBENCH_UPDATE_GOLDENS === '1') {
    mkdirSync(goldenDir, { recursive: true });
    writeFileSync(file, `${actual}\n`, 'utf-8');
    return;
  }
  expect(existsSync(file), `missing golden ${name}.xml`).toBe(true);
  expect(actual).toBe(readFileSync(file, 'utf-8').replace(/\n$/, ''));
}

const GOLDEN_ELEMENTS: readonly (readonly [string, string])[] = [
  ['Level3El', TNS],
  ['Level3RestrictedEl', TNS],
  ['ShapeEl', TNS],
  ['AmountEl', TNS],
  ['ChoiceEl', TNS],
  ['AllEl', TNS],
  ['GroupUserEl', TNS],
  ['NodeEl', TNS],
  ['AnyHolderEl', TNS],
  ['MixedEl', TNS],
  ['EmptyEl', TNS],
  ['StringArrayEl', TNS],
  ['NillableThing', TNS],
  ['AnonRoot', TNS],
  ['Vehicle', TNS],
  ['OtherRoot', OTHER],
];

const MATRIX: readonly (readonly [string, Partial<GenerateOptions>])[] = [
  ['noopt-placeholder', { includeOptional: false, sampleValues: false }],
  ['opt-placeholder', { includeOptional: true, sampleValues: false }],
  ['noopt-sample', { includeOptional: false, sampleValues: true }],
  // typeComments are exercised on exactly one arm of the matrix.
  ['opt-sample', { includeOptional: true, sampleValues: true, typeComments: true }],
];

describe('generateElement — goldens per construct × option matrix', () => {
  for (const [local, ns] of GOLDEN_ELEMENTS) {
    for (const [label, options] of MATRIX) {
      it(`${local} ${label}`, () => {
        expectGolden(`${local}-${label}`, generateElement(set, q(ns, local), options).xml);
      });
    }
  }
});

describe('generateElement — rules', () => {
  it('omits optional elements unless includeOptional, and comments them when included', () => {
    const without = generateElement(set, q(TNS, 'AnonRoot'), { includeOptional: false }).xml;
    expect(without).not.toContain('inner');
    expect(without).not.toContain('Optional:');
    const withOptional = generateElement(set, q(TNS, 'AnonRoot'), { includeOptional: true }).xml;
    expect(withOptional).toContain('<!--Optional:-->');
    expect(withOptional).toContain('inner');
  });

  it('comments repeating particles by their minOccurs', () => {
    const node = generateElement(set, q(TNS, 'NodeEl'), { includeOptional: true }).xml;
    expect(node).toContain('<!--Zero or more repetitions:-->');
    const group = generateElement(set, q(TNS, 'GroupUserEl'), { includeOptional: true }).xml;
    // <xs:group ref="other:NamePart" minOccurs="1" maxOccurs="2"/>
    expect(group).toContain('<!--1 or more repetitions:-->');
    const many = generateElement(
      schemaSetFromXml(`<xs:schema xmlns:xs="${XSD}" targetNamespace="urn:t" elementFormDefault="qualified">
        <xs:element name="R"><xs:complexType><xs:sequence>
          <xs:element name="m" type="xs:string" minOccurs="2" maxOccurs="5"/>
        </xs:sequence></xs:complexType></xs:element>
      </xs:schema>`),
      q('urn:t', 'R'),
    ).xml;
    expect(many).toContain('<!--2 or more repetitions:-->');
    expect(many.match(/<ns1:m>/g)).toHaveLength(1);
  });

  it('emits one CHOICE comment naming the number of alternatives, then every alternative', () => {
    const xml = generateElement(set, q(TNS, 'ChoiceEl'), { includeOptional: true }).xml;
    expect(xml.match(/<!--You have a CHOICE of the next 2 items at this level-->/g)).toHaveLength(1);
    expect(xml).toContain('single');
    expect(xml).toContain('many');
  });

  it('emits every choice alternative even when includeOptional is false', () => {
    const xml = generateElement(set, q(TNS, 'ChoiceEl'), { includeOptional: false }).xml;
    const announced = xml.match(/You have a CHOICE of the next (\d+) items at this level/);
    expect(announced).not.toBeNull();
    // <xs:choice> has 2 direct alternatives: `single`, and the `minOccurs="0"` sequence.
    expect(announced?.[1]).toBe('2');
    expect(xml).toContain('single');
    // The optional alternative (a sequence) is still emitted in full even though
    // it is minOccurs="0" — choice gating overrides compositor optionality.
    expect(xml).toContain('many');
    // But content nested inside that alternative that is itself optional (not a
    // choice alternative) is still gated by includeOptional as usual.
    expect(xml).not.toContain('tag');
  });

  it('emits xsi:type with the first concrete derived type for an abstract type', () => {
    const xml = generateElement(set, q(TNS, 'ShapeEl')).xml;
    expect(xml).toContain('xsi:type="ns1:Circle"');
    expect(xml).toContain(`xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`);
    expect(xml).toContain('radius');
  });

  it('substitutes the first concrete member for an abstract head element', () => {
    const xml = generateElement(set, q(TNS, 'Vehicle')).xml;
    expect(xml).toContain('<ns1:Car');
    expect(xml).not.toContain('<ns1:Vehicle');
  });

  it('cuts recursion at maxDepth with exactly one comment', () => {
    const xml = generateElement(set, q(TNS, 'NodeEl'), { includeOptional: true, maxDepth: 2 }).xml;
    expect(xml.match(/<!--Recursion depth exceeded \(ns1:Node\)-->/g)).toHaveLength(1);
    expect(xml.match(/<ns1:child/g)).toHaveLength(2);
  });

  it('lists every enumeration value in the type comment', () => {
    const xml = generateElement(set, q(OTHER, 'OtherRoot'), { includeOptional: true, typeComments: true }).xml;
    expect(xml).toContain('<!--type: xs:string - enumeration: [RED, GREEN, BLUE]-->');
    expect(xml).toContain('<!--type: xs:string-->');
  });

  it('uses fixed and default values in place of placeholders', () => {
    const xml = generateElement(set, q(TNS, 'Level3El'), { includeOptional: true }).xml;
    expect(xml).toContain('<ns1:c>RED</ns1:c>');
    expect(xml).toContain('<ns1:b>7</ns1:b>');
    expect(xml).toContain('attr1="?"');
  });

  it('emits unqualified local elements without a prefix and qualified ones with one', () => {
    const xml = generateElement(set, q(OTHER, 'OtherRoot')).xml;
    expect(xml).toContain('<ns1:OtherRoot');
    expect(xml).toContain('<label>?</label>');
    expect(generateElement(set, q(TNS, 'Level3El')).xml).toContain('<ns1:a>?</ns1:a>');
  });

  it('honours the prefixes option and reports the namespaces used', () => {
    const fragment = generateElement(set, q(TNS, 'Level3El'), { prefixes: { [TNS]: 'tns' } });
    expect(fragment.xml).toContain('<tns:Level3El');
    expect(fragment.namespaces).toEqual({ tns: TNS });
  });

  it('is deterministic across runs', () => {
    const a = generateElement(set, q(TNS, 'GroupUserEl'), { includeOptional: true, sampleValues: true }).xml;
    const b = generateElement(set, q(TNS, 'GroupUserEl'), { includeOptional: true, sampleValues: true }).xml;
    expect(a).toBe(b);
  });

  it('emits a wildcard comment for xs:any and a plain placeholder for anyType', () => {
    const xml = generateElement(set, q(TNS, 'AnyHolderEl'), { includeOptional: true }).xml;
    expect(xml).toContain('<!--You may enter ANY elements at this point-->');
    expect(xml).toContain('<ns1:blob>?</ns1:blob>');
    // anyAttribute is ignored entirely.
    expect(xml).not.toContain('ANY attributes');
  });

  it('never adds xsi:nil for a nillable element', () => {
    expect(generateElement(set, q(TNS, 'NillableThing')).xml).toBe(
      '<ns1:NillableThing xmlns:ns1="urn:wb:sc">?</ns1:NillableThing>',
    );
  });

  it('emits simpleContent as text plus attributes', () => {
    expect(generateElement(set, q(TNS, 'AmountEl')).xml).toBe(
      '<ns1:AmountEl xmlns:ns1="urn:wb:sc" currency="EUR">?</ns1:AmountEl>',
    );
  });

  it('throws for an unknown element', () => {
    expect(() => generateElement(set, q(TNS, 'NoSuchElement'))).toThrow(/NoSuchElement/);
  });
});

describe('sample values', () => {
  it('derives values from facets', () => {
    const xml = generateElement(set, q(OTHER, 'OtherRoot'), { includeOptional: true, sampleValues: true }).xml;
    // ColorCode enumerates RED first; ColorList is a list of ColorCode (two items).
    expect(xml).toContain('<color>RED</color>');
    expect(xml).toContain('<codes>RED RED</codes>');
  });

  it('uses the first union member and length facets', () => {
    const xml = generateElement(set, q(TNS, 'AnonRoot'), { includeOptional: true, sampleValues: true }).xml;
    // CodeOrNumber unions Code5 (length 5) first.
    expect(xml).toContain('<ns1:pick>?????</ns1:pick>');
    expect(xml).toContain('<ns1:inner>ONE</ns1:inner>');
  });

  it('applies minInclusive/maxExclusive bounds', () => {
    const xml = generateElement(set, q(TNS, 'Vehicle'), { sampleValues: true }).xml;
    // SmallInt: minInclusive 1
    expect(xml).toContain('<ns1:wheels>1</ns1:wheels>');
    const bounded = generateElement(
      schemaSetFromXml(`<xs:schema xmlns:xs="${XSD}" xmlns:t="urn:t" targetNamespace="urn:t" elementFormDefault="qualified">
        <xs:simpleType name="Big"><xs:restriction base="xs:int"><xs:minExclusive value="10"/></xs:restriction></xs:simpleType>
        <xs:element name="B" type="t:Big"/>
      </xs:schema>`),
      q('urn:t', 'B'),
      { sampleValues: true },
    ).xml;
    expect(bounded).toContain('>11<');
  });

  it('uses the built-in sample value otherwise', () => {
    const xml = generateElement(set, q(TNS, 'Level3El'), { sampleValues: true }).xml;
    expect(xml).toContain('<ns1:a>string</ns1:a>');
    expect(xml).toContain('attr1="string"');
  });
});

describe('generateType and generateSoapEncArray', () => {
  it('generates an element declared by type', () => {
    const fragment = generateType(set, q('', 'shape'), q(TNS, 'Circle'));
    expect(fragment.xml).toContain('<shape ');
    expect(fragment.xml).toContain('radius');
  });

  it('generates a SOAP-encoded array wrapper', () => {
    const fragment = generateSoapEncArray(set, q(TNS, 'items'), q(XSD, 'string'));
    expect(fragment.xml).toContain('soapenc:arrayType="xs:string[1]"');
    expect(fragment.xml).toContain('<item>?</item>');
    expect(fragment.namespaces['soapenc']).toBe('http://schemas.xmlsoap.org/soap/encoding/');
  });

  it('recognises a soapenc:Array restriction on a declared element', () => {
    const xml = generateElement(set, q(TNS, 'StringArrayEl')).xml;
    expect(xml).toContain('soapenc:arrayType="xs:string[1]"');
    expect(xml).toContain('<item>?</item>');
  });
});

describe('public fixtures', () => {
  it('generates the Calculator Add request body', async () => {
    const calc = await schemaSetFromWsdlText(readPublicFixture('calculator'), fileUrl('/calculator.wsdl'));
    const xml = generateElement(calc, q('http://tempuri.org/', 'Add'), {
      prefixes: { 'http://tempuri.org/': 'tem' },
    }).xml;
    expect(xml.replace(/\s+/g, '')).toBe(
      '<tem:Addxmlns:tem="http://tempuri.org/"><tem:intA>?</tem:intA><tem:intB>?</tem:intB></tem:Add>',
    );
  });

  it('generates CountryInfo ListOfCountryNamesByCode without error', async () => {
    const country = await schemaSetFromWsdlText(readPublicFixture('countryinfo'), fileUrl('/countryinfo.wsdl'));
    const xml = generateElement(
      country,
      q('http://www.oorsprong.org/websamples.countryinfo', 'ListOfCountryNamesByCode'),
      {
        includeOptional: true,
      },
    ).xml;
    expect(xml).toContain('ListOfCountryNamesByCode');
  });

  it('generates NumberConversion NumberToWords with a placeholder and a typed sample', async () => {
    const numbers = await schemaSetFromWsdlText(
      readPublicFixture('numberconversion'),
      fileUrl('/numberconversion.wsdl'),
    );
    const name = q('http://www.dataaccess.com/webservicesserver/', 'NumberToWords');
    expect(generateElement(numbers, name).xml).toContain('<ns1:ubiNum>?</ns1:ubiNum>');
    expect(generateElement(numbers, name, { sampleValues: true }).xml).toContain('<ns1:ubiNum>1</ns1:ubiNum>');
  });
});

describe('edge cases', () => {
  const edgeSchema = `<xs:schema xmlns:xs="${XSD}" xmlns:t="urn:t" targetNamespace="urn:t" elementFormDefault="qualified">
      <xs:simpleType name="Capped"><xs:restriction base="xs:string"><xs:maxLength value="4"/></xs:restriction></xs:simpleType>
      <xs:simpleType name="UpTo"><xs:restriction base="xs:int"><xs:maxInclusive value="9"/></xs:restriction></xs:simpleType>
      <xs:simpleType name="Under"><xs:restriction base="xs:int"><xs:maxExclusive value="9"/></xs:restriction></xs:simpleType>
      <xs:simpleType name="Loose"><xs:restriction base="xs:date"><xs:maxExclusive value="2001-01-01"/></xs:restriction></xs:simpleType>
      <xs:simpleType name="InlineList"><xs:list><xs:simpleType><xs:restriction base="xs:int"/></xs:simpleType></xs:list></xs:simpleType>
      <xs:simpleType name="Loop"><xs:restriction base="t:Loop"/></xs:simpleType>
      <xs:simpleType name="Aliased"><xs:restriction base="soapenc:string"/></xs:simpleType>
      <xs:group name="Cycle"><xs:sequence><xs:group ref="t:Cycle"/></xs:sequence></xs:group>
      <xs:element name="Ref" type="xs:string"/>
      <xs:element name="Holder">
        <xs:complexType><xs:sequence>
          <xs:element ref="t:Ref"/>
          <xs:element name="missing" type="t:NoSuchType"/>
          <xs:element name="marked" type="xs:string" fixed="a &amp; b &lt; c"/>
        </xs:sequence>
        <xs:attribute name="quoted" type="xs:string" use="required" fixed='say "hi"'/>
        </xs:complexType>
      </xs:element>
      <xs:complexType name="Grouped"><xs:group ref="t:Cycle"/></xs:complexType>
      <xs:element name="GroupedEl" type="t:Grouped"/>
    </xs:schema>`;
  let edge: SchemaSet;

  beforeAll(() => {
    edge = schemaSetFromXml(
      edgeSchema.replace('<xs:schema ', `<xs:schema xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" `),
    );
  });

  it('escapes text, attribute values and keeps unresolved types as placeholders', () => {
    const xml = generateElement(edge, q('urn:t', 'Holder')).xml;
    expect(xml).toContain('<ns1:marked>a &amp; b &lt; c</ns1:marked>');
    expect(xml).toContain('quoted="say &quot;hi&quot;"');
    expect(xml).toContain('<ns1:missing>?</ns1:missing>');
    expect(xml).toContain('<ns1:Ref>?</ns1:Ref>');
  });

  it('survives a self-referential group reference', () => {
    expect(generateElement(edge, q('urn:t', 'GroupedEl')).xml).toBe('<ns1:GroupedEl xmlns:ns1="urn:t"/>');
  });

  it('derives values from max bounds, inline list items and aliases', () => {
    const value = (local: string): string => sampleValueFor(edge, q('urn:t', local), { sampleValues: true });
    expect(value('UpTo')).toBe('9');
    expect(value('Under')).toBe('8');
    expect(value('Loose')).toBe('2001-01-01');
    expect(value('InlineList')).toBe('1 1');
    expect(value('Loop')).toBe('?');
    expect(value('Aliased')).toBe('string');
    expect(value('Capped')).toBe('string');
    expect(value('NoSuchType')).toBe('?');
    expect(sampleValueFor(edge, undefined, { sampleValues: true })).toBe('?');
    expect(sampleValueFor(edge, q('urn:t', 'UpTo'), { sampleValues: false })).toBe(PLACEHOLDER);
  });

  it('describes list, union and unknown types in comments', () => {
    expect(typeCommentFor(edge, q('urn:t', 'InlineList'))).toBe('type: list of xs:int');
    expect(typeCommentFor(edge, undefined)).toBeUndefined();
    expect(typeCommentFor(edge, q('urn:t', 'NoSuchType'))).toBe('type: NoSuchType');
    // A cyclic restriction chain has no resolvable built-in base: the type's own name is reported.
    expect(typeCommentFor(edge, q('urn:t', 'Loop'))).toBe('type: Loop');
  });

  it('falls back to a generated prefix when the preferred one is taken', () => {
    const fragment = generateElement(set, q(TNS, 'ShapeEl'), { prefixes: { [TNS]: 'xsi' } });
    expect(fragment.xml).toContain('<xsi:ShapeEl');
    expect(fragment.xml).toContain('ns1:type="xsi:Circle"');
  });

  it('generates simple-typed and anyType parts by type', () => {
    expect(generateType(set, q(TNS, 'part'), q(XSD, 'string'), { typeComments: true }).xml).toBe(
      '<ns1:part xmlns:ns1="urn:wb:sc"><!--type: xs:string-->?</ns1:part>',
    );
    expect(generateType(set, q('', 'part'), q(XSD, 'anyType')).xml).toBe('<part>?</part>');
    expect(generateType(set, q('', 'part'), q(TNS, 'StringArray')).xml).toContain('soapenc:arrayType="xs:string[1]"');
  });

  it('generates an encoded array of a user-defined item type', () => {
    const xml = generateSoapEncArray(set, q(TNS, 'colors'), q(OTHER, 'ColorCode'), { sampleValues: true }).xml;
    expect(xml).toContain('soapenc:arrayType="ns2:ColorCode[1]"');
    expect(xml).toContain('<item>RED</item>');
  });

  it('reports an array with no wsdl:arrayType as xs:anyType', () => {
    const arrays =
      schemaSetFromXml(`<xs:schema xmlns:xs="${XSD}" xmlns:t="urn:t" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/" targetNamespace="urn:t" elementFormDefault="qualified">
        <xs:complexType name="Bare"><xs:complexContent><xs:restriction base="soapenc:Array"/></xs:complexContent></xs:complexType>
        <xs:element name="BareEl" type="t:Bare"/>
        <xs:element name="DirectEl" type="soapenc:Array"/>
      </xs:schema>`);
    expect(generateElement(arrays, q('urn:t', 'BareEl')).xml).toContain('soapenc:arrayType="xs:anyType[1]"');
    expect(generateElement(arrays, q('urn:t', 'DirectEl')).xml).toContain('soapenc:arrayType="xs:anyType[1]"');
  });
});
