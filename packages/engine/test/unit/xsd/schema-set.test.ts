import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseXml } from '../../../src/xml/parse.js';
import { NS } from '../../../src/xml/namespaces.js';
import { createDefaultFetchDocument } from '../../../src/wsdl/fetch.js';
import { parseWsdl } from '../../../src/wsdl/parse-wsdl.js';
import { resolveDefinition } from '../../../src/wsdl/resolver.js';
import { buildSchemaSet } from '../../../src/xsd/schema-set.js';
import type { SchemaSet } from '../../../src/xsd/schema-set.js';
import type { All, Choice, ComplexType, LocalElement, Particle, Sequence, SimpleType } from '../../../src/xsd/model.js';
import { readPublicFixture } from '../../helpers/fixtures.js';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const craftedRoot = `${repoRoot}fixtures/wsdl/crafted/`;

const TNS = 'urn:wb:sc';
const OTHER = 'urn:wb:sc:other';

const q = (ns: string, local: string) => ({ namespaceUri: ns, localName: local });

/** Builds the schema set from an ad-hoc standalone `xs:schema` document. */
function schemaSetFromXml(...xml: readonly string[]): SchemaSet {
  const schemaElements = xml.map((text) => {
    const doc = parseXml(text, { location: 'inline.xsd' });
    const root = doc.documentElement;
    if (root === null) {
      throw new Error('no document element');
    }
    return root;
  });
  return buildSchemaSet({ schemaElements });
}

function expectComplex(set: SchemaSet, ns: string, local: string): ComplexType {
  const type = set.lookupType(q(ns, local));
  expect(type, `${local} should exist`).toBeDefined();
  expect(type?.kind).toBe('complexType');
  return type as ComplexType;
}

function expectSimple(set: SchemaSet, ns: string, local: string): SimpleType {
  const type = set.lookupType(q(ns, local));
  expect(type?.kind).toBe('simpleType');
  return type as SimpleType;
}

function localNames(particles: readonly Particle[]): string[] {
  return particles.map((p) => (p.kind === 'localElement' ? p.decl.name.localName : p.kind));
}

describe('buildSchemaSet — crafted/schema-constructs', () => {
  let set: SchemaSet;

  beforeAll(async () => {
    const bundle = await resolveDefinition(
      { location: new URL('schema-constructs/service.wsdl', `file://${craftedRoot}`).toString() },
      { fetchDocument: createDefaultFetchDocument() },
    );
    set = buildSchemaSet(bundle);
  });

  it('builds with no problems and lists both namespaces', () => {
    expect(set.problems).toEqual([]);
    expect([...set.namespaces].sort()).toEqual([TNS, OTHER]);
  });

  it('indexes global components and exposes per-namespace listings', () => {
    expect(set.lookupElement(q(TNS, 'Level3El'))?.type).toEqual(q(TNS, 'Level3'));
    expect(set.lookupElement(q(OTHER, 'OtherRoot'))?.type).toEqual(q(OTHER, 'OtherPayload'));
    expect(set.lookupGroup(q(OTHER, 'NamePart'))?.particle.kind).toBe('sequence');
    expect(set.lookupAttributeGroup(q(OTHER, 'CommonAttrs'))?.attributes).toHaveLength(2);
    expect(set.lookupAttribute(q(TNS, 'version'))?.name).toEqual(q(TNS, 'version'));
    expect(
      set
        .elementsInNamespace(OTHER)
        .map((e) => e.name.localName)
        .sort(),
    ).toEqual(['OtherRoot', 'OtherRootResponse']);
    expect(set.typesInNamespace(OTHER).map((t) => t.name?.localName)).toContain('ColorCode');
    expect(set.elementsInNamespace('urn:absent')).toEqual([]);
  });

  it('records source locations for global components', () => {
    const other = set.lookupType(q(OTHER, 'ColorCode'));
    expect(other?.source.location).toMatch(/schemas\/other\.xsd$/);
    expect(other?.source.line).toBeGreaterThan(0);
    expect(other?.source.column).toBeGreaterThan(0);
    expect(set.lookupType(q(TNS, 'Level1'))?.source.location).toMatch(/service\.wsdl$/);
  });

  it('captures annotation documentation', () => {
    expect(set.lookupType(q(TNS, 'Level1'))?.documentation).toBe('Root of the three-deep extension chain.');
    expect(set.lookupType(q(OTHER, 'ColorCode'))?.documentation).toBe('An enumerated colour.');
  });

  it('honours elementFormDefault when naming local elements', () => {
    const level1 = expectComplex(set, TNS, 'Level1');
    expect(level1.content.kind).toBe('particle');
    const particle = (level1.content as { particle: Sequence }).particle;
    const a = particle.particles[0] as LocalElement;
    expect(a.decl.name).toEqual(q(TNS, 'a'));

    const payload = expectComplex(set, OTHER, 'OtherPayload');
    const label = ((payload.content as { particle: Sequence }).particle.particles[0] as LocalElement).decl;
    expect(label.name).toEqual(q('', 'label'));
  });

  it('parses occurs on nested compositors', () => {
    const choice = expectComplex(set, TNS, 'ChoiceType');
    const outer = (choice.content as { particle: Choice }).particle;
    expect(outer.kind).toBe('choice');
    expect(outer.occurs).toEqual({ min: 1, max: 1 });
    expect(outer.particles).toHaveLength(2);
    const nested = outer.particles[1] as Sequence;
    expect(nested.kind).toBe('sequence');
    expect(nested.occurs).toEqual({ min: 0, max: 'unbounded' });
    expect((nested.particles[1] as LocalElement).occurs).toEqual({ min: 0, max: 3 });
  });

  it('parses xs:all', () => {
    const all = (expectComplex(set, TNS, 'AllType').content as { particle: All }).particle;
    expect(all.kind).toBe('all');
    expect(localNames(all.particles)).toEqual(['p', 'q']);
    expect((all.particles[0] as LocalElement).occurs).toEqual({ min: 0, max: 1 });
  });

  it('parses default and fixed values on local elements', () => {
    const level2 = expectComplex(set, TNS, 'Level2');
    const b = ((level2.content as { particle: Sequence }).particle.particles[0] as LocalElement).decl;
    expect(b.default).toBe('7');
    const level3 = expectComplex(set, TNS, 'Level3');
    const c = ((level3.content as { particle: Sequence }).particle.particles[0] as LocalElement).decl;
    expect(c.fixed).toBe('RED');
    expect(c.type).toEqual(q(OTHER, 'ColorCode'));
  });

  it('parses abstract, nillable and substitution groups', () => {
    expect(set.lookupElement(q(TNS, 'Vehicle'))?.abstract).toBe(true);
    expect(set.lookupElement(q(TNS, 'Car'))?.substitutionGroup).toEqual(q(TNS, 'Vehicle'));
    expect(set.lookupElement(q(TNS, 'NillableThing'))?.nillable).toBe(true);
    expect(set.lookupElement(q(TNS, 'Car'))?.nillable).toBe(false);
    expect(expectComplex(set, TNS, 'AbstractShape').abstract).toBe(true);
  });

  it('resolves substitution group members transitively', () => {
    expect(set.substitutionsFor(q(TNS, 'Vehicle')).map((e) => e.name.localName)).toEqual(['Car', 'Truck']);
    expect(set.substitutionsFor(q(TNS, 'Car')).map((e) => e.name.localName)).toEqual(['Truck']);
    expect(set.substitutionsFor(q(TNS, 'Truck'))).toEqual([]);
  });

  it('parses wildcards and mixed/empty content', () => {
    const anyHolder = expectComplex(set, TNS, 'AnyHolder');
    const seq = (anyHolder.content as { particle: Sequence }).particle;
    const wildcard = seq.particles[0];
    expect(wildcard).toMatchObject({
      kind: 'any',
      namespace: '##other',
      processContents: 'lax',
      occurs: { min: 0, max: 'unbounded' },
    });
    const blob = seq.particles[1] as LocalElement;
    expect(blob.decl.type).toEqual(q(NS.XSD, 'anyType'));
    expect((anyHolder.content as { attributes: readonly { kind: string }[] }).attributes[0]?.kind).toBe('anyAttribute');

    expect(expectComplex(set, TNS, 'MixedText').mixed).toBe(true);
    expect(expectComplex(set, TNS, 'EmptyType').content.kind).toBe('empty');
  });

  it('parses anonymous complex and simple types', () => {
    const anon = set.lookupElement(q(TNS, 'AnonRoot'));
    expect(anon?.type).toBeUndefined();
    const anonType = anon?.anonymousType as ComplexType;
    expect(anonType.kind).toBe('complexType');
    expect(anonType.name).toBeUndefined();
    const inner = ((anonType.content as { particle: Sequence }).particle.particles[0] as LocalElement).decl;
    const innerType = inner.anonymousType as SimpleType;
    expect(innerType.kind).toBe('simpleType');
    expect(innerType.facets).toEqual([{ kind: 'enumeration', values: ['ONE', 'TWO'] }]);
  });

  it.each([
    ['ColorCode', { kind: 'enumeration', values: ['RED', 'GREEN', 'BLUE'] }],
    ['SmallInt', { kind: 'minInclusive', value: '1' }],
    ['SmallInt', { kind: 'maxExclusive', value: '100' }],
    ['Code5', { kind: 'length', value: 5 }],
    ['Code5', { kind: 'pattern', value: '[A-Z]{5}' }],
    ['Code5', { kind: 'whiteSpace', value: 'collapse' }],
  ])('parses facets of %s', (name, facet) => {
    expect(expectSimple(set, OTHER, name).facets).toContainEqual(facet);
  });

  it('parses list and union varieties', () => {
    const list = expectSimple(set, OTHER, 'ColorList');
    expect(list.variety).toBe('list');
    expect(list.itemType).toEqual(q(OTHER, 'ColorCode'));

    const inlineList = expectSimple(set, OTHER, 'InlineList');
    expect((inlineList.itemType as SimpleType).kind).toBe('simpleType');

    const union = expectSimple(set, OTHER, 'CodeOrNumber');
    expect(union.variety).toBe('union');
    expect(union.memberTypes?.slice(0, 2)).toEqual([q(OTHER, 'Code5'), q(NS.XSD, 'int')]);
    expect((union.memberTypes?.[2] as SimpleType).kind).toBe('simpleType');

    expect(expectSimple(set, OTHER, 'ColorCode').variety).toBe('atomic');
    expect(expectSimple(set, OTHER, 'ColorCode').base).toEqual(q(NS.XSD, 'string'));
  });

  it('parses simpleContent extension and restriction', () => {
    const amount = expectComplex(set, TNS, 'Amount');
    expect(amount.content).toMatchObject({
      kind: 'simpleContent',
      derivation: 'extension',
      base: q(NS.XSD, 'decimal'),
    });
    const short = expectComplex(set, TNS, 'ShortAmount');
    expect(short.content).toMatchObject({ kind: 'simpleContent', derivation: 'restriction', base: q(TNS, 'Amount') });
    expect((short.content as { facets?: unknown[] }).facets).toContainEqual({ kind: 'maxInclusive', value: '1000' });
  });

  it('parses the soapenc array restriction and its arrayType attribute', () => {
    const array = expectComplex(set, TNS, 'StringArray');
    expect(array.content).toMatchObject({
      kind: 'complexContent',
      derivation: 'restriction',
      base: q(NS.SOAP11_ENC, 'Array'),
    });
    expect((array.content as { attributes: readonly { kind: string; ref?: unknown }[] }).attributes[0]).toMatchObject({
      kind: 'attributeRef',
      ref: q(NS.SOAP11_ENC, 'arrayType'),
    });
    expect(set.isBuiltin(q(NS.SOAP11_ENC, 'Array'))).toBe(true);
    expect(set.builtin(q(NS.SOAP11_ENC, 'Array'))?.soapEncArray).toBe(true);
  });
});

describe('resolveContent — crafted/schema-constructs', () => {
  let set: SchemaSet;

  beforeAll(async () => {
    const definition = await parseWsdl(
      { location: new URL('schema-constructs/service.wsdl', `file://${craftedRoot}`).toString() },
      { fetchDocument: createDefaultFetchDocument(), resolveImports: true },
    );
    set = buildSchemaSet(definition);
  });

  it('flattens a depth-3 extension chain base-first and merges attributes', () => {
    const resolved = set.resolveContent(expectComplex(set, TNS, 'Level3'));
    expect(resolved.particle?.kind).toBe('sequence');
    expect(localNames((resolved.particle as Sequence).particles)).toEqual(['a', 'b', 'c']);
    expect(resolved.attributes.map((a) => a.name.localName)).toEqual(['attr1', 'attr2', 'attr3']);
    expect(resolved.attributes[0]).toMatchObject({ use: 'required', type: q(NS.XSD, 'string') });
    expect(resolved.mixed).toBe(false);
  });

  it('keeps only the restricted particle and drops prohibited attributes', () => {
    const resolved = set.resolveContent(expectComplex(set, TNS, 'Level3Restricted'));
    expect(localNames((resolved.particle as Sequence).particles)).toEqual(['a', 'b', 'c']);
    const names = resolved.attributes.map((a) => a.name.localName);
    expect(names).toContain('attr3');
    expect(names).toContain('attr2');
    expect(names).not.toContain('attr1');
    expect(resolved.attributes.find((a) => a.name.localName === 'attr3')?.use).toBe('required');
  });

  it('expands group refs in place, preserving the ref occurs', () => {
    const resolved = set.resolveContent(expectComplex(set, TNS, 'GroupUser'));
    const particles = (resolved.particle as Sequence).particles;
    expect(particles).toHaveLength(2);
    const expanded = particles[0] as Sequence;
    expect(expanded.kind).toBe('sequence');
    expect(expanded.occurs).toEqual({ min: 1, max: 2 });
    expect(localNames(expanded.particles)).toEqual(['first', 'last']);
    expect(localNames([particles[1] as Particle])).toEqual(['note']);
  });

  it('expands attribute groups and global attribute refs', () => {
    const resolved = set.resolveContent(expectComplex(set, TNS, 'GroupUser'));
    expect(resolved.attributes.map((a) => a.name.localName).sort()).toEqual(['id', 'lang', 'version']);
    expect(resolved.attributes.find((a) => a.name.localName === 'id')?.use).toBe('required');
    expect(resolved.attributes.find((a) => a.name.localName === 'lang')?.default).toBe('en');
    expect(resolved.attributes.find((a) => a.name.localName === 'version')?.type).toEqual(q(NS.XSD, 'string'));
  });

  it('resolves the ultimate simple base of a simpleContent chain', () => {
    expect(set.resolveContent(expectComplex(set, TNS, 'ShortAmount')).simpleContentBase).toEqual(q(NS.XSD, 'decimal'));
    const amount = set.resolveContent(expectComplex(set, TNS, 'Amount'));
    expect(amount.simpleContentBase).toEqual(q(NS.XSD, 'decimal'));
    expect(amount.attributes.map((a) => a.name.localName)).toEqual(['currency']);
    expect(amount.attributes[0]?.fixed).toBe('EUR');
  });

  it('terminates on a recursive type', () => {
    const resolved = set.resolveContent(expectComplex(set, TNS, 'Node'));
    expect(localNames((resolved.particle as Sequence).particles)).toEqual(['child']);
    expect(resolved.attributes.map((a) => a.name.localName)).toEqual(['label']);
  });

  it('reports mixed content and surfaces anyAttribute', () => {
    expect(set.resolveContent(expectComplex(set, TNS, 'MixedText')).mixed).toBe(true);
    const any = set.resolveContent(expectComplex(set, TNS, 'AnyHolder'));
    expect(any.anyAttribute).toEqual({ namespace: '##any', processContents: 'skip' });
    expect(any.attributes).toEqual([]);
  });

  it('resolves empty content and a soapenc array base without hanging', () => {
    expect(set.resolveContent(expectComplex(set, TNS, 'EmptyType')).particle).toBeUndefined();
    const array = set.resolveContent(expectComplex(set, TNS, 'StringArray'));
    expect(array.attributes.map((a) => a.name.localName)).toEqual(['arrayType']);
  });

  it('resolves cross-namespace element and type references', () => {
    const payload = set.lookupType(set.lookupElement(q(OTHER, 'OtherRoot'))!.type!);
    expect(payload?.name).toEqual(q(OTHER, 'OtherPayload'));
    expect(set.resolveContent(payload as ComplexType).attributes.map((a) => a.name.localName)).toEqual(['id', 'lang']);
  });

  it('inherits base attributes through a simpleContent extension chain', () => {
    const taxed = set.resolveContent(expectComplex(set, TNS, 'TaxedAmount'));
    const names = taxed.attributes.map((a) => a.name.localName).sort();
    expect(names).toEqual(['currency', 'rate']);
    const currency = taxed.attributes.find((a) => a.name.localName === 'currency');
    expect(currency?.fixed).toBe('EUR');
    expect(currency?.use).toBe('required');
    expect(taxed.simpleContentBase).toEqual(q(NS.XSD, 'decimal'));
  });

  it('inherits an unrestated base attribute through a simpleContent restriction', () => {
    const restricted = set.resolveContent(expectComplex(set, TNS, 'TaxedAmountRestricted'));
    const currency = restricted.attributes.find((a) => a.name.localName === 'currency');
    expect(currency).toBeDefined();
    expect(currency?.fixed).toBe('EUR');
    expect(currency?.use).toBe('required');
    expect(restricted.simpleContentBase).toEqual(q(NS.XSD, 'decimal'));
  });

  it('inherits mixed from the base through a complexContent restriction that does not restate it', () => {
    const restricted = set.resolveContent(expectComplex(set, TNS, 'MixedTextRestricted'));
    expect(restricted.mixed).toBe(true);
  });

  it('inherits anyAttribute from the base through a complexContent restriction that does not restate it', () => {
    const restricted = set.resolveContent(expectComplex(set, TNS, 'AnyHolderRestricted'));
    expect(restricted.anyAttribute).toEqual({ namespace: '##any', processContents: 'skip' });
  });
});

describe('buildSchemaSet — problems and edge cases', () => {
  it('records unresolved references instead of throwing', () => {
    const set = schemaSetFromXml(`<?xml version="1.0"?>
      <xs:schema xmlns:xs="${NS.XSD}" xmlns:t="urn:t" targetNamespace="urn:t">
        <xs:element name="E" type="t:Missing"/>
        <xs:complexType name="C">
          <xs:sequence>
            <xs:group ref="t:NoGroup"/>
            <xs:element ref="t:NoElement"/>
          </xs:sequence>
          <xs:attributeGroup ref="t:NoAttrs"/>
        </xs:complexType>
        <xs:complexType name="D">
          <xs:complexContent><xs:extension base="t:NoBase"/></xs:complexContent>
        </xs:complexType>
      </xs:schema>`);
    const codes = set.problems.map((p) => p.code);
    expect(new Set(codes)).toEqual(new Set(['unresolved-ref']));
    expect(set.problems.map((p) => p.message).join('\n')).toContain('Missing');
    expect(set.problems).toHaveLength(5);
    expect(set.problems[0]?.location).toBe('<inline>');
    expect(set.lookupType({ namespaceUri: 'urn:t', localName: 'Missing' })).toBeUndefined();
    expect(
      set.resolveContent(set.lookupType({ namespaceUri: 'urn:t', localName: 'D' }) as ComplexType).particle,
    ).toBeUndefined();
  });

  it('reports duplicate global components and keeps the first', () => {
    const set = schemaSetFromXml(
      `<?xml version="1.0"?><xs:schema xmlns:xs="${NS.XSD}" targetNamespace="urn:t">
        <xs:element name="E" type="xs:string"/></xs:schema>`,
      `<?xml version="1.0"?><xs:schema xmlns:xs="${NS.XSD}" targetNamespace="urn:t">

        <xs:element name="E" type="xs:int"/></xs:schema>`,
    );
    expect(set.problems.map((p) => p.code)).toEqual(['duplicate-component']);
    expect(set.lookupElement({ namespaceUri: 'urn:t', localName: 'E' })?.type?.localName).toBe('string');
  });

  it('silently skips a component re-encountered at the same location and line', () => {
    const text = `<?xml version="1.0"?><xs:schema xmlns:xs="${NS.XSD}" targetNamespace="urn:t">
        <xs:element name="E" type="xs:string"/></xs:schema>`;
    const set = schemaSetFromXml(text, text);
    expect(set.problems).toEqual([]);
  });

  it('reports xs:redefine content as unsupported and ignores import/include', () => {
    const set = schemaSetFromXml(`<?xml version="1.0"?>
      <xs:schema xmlns:xs="${NS.XSD}" targetNamespace="urn:t">
        <xs:import namespace="urn:other"/>
        <xs:include schemaLocation="x.xsd"/>
        <xs:redefine schemaLocation="y.xsd">
          <xs:complexType name="R"/>
        </xs:redefine>
      </xs:schema>`);
    expect(set.problems.map((p) => p.code)).toEqual(['unsupported']);
    expect(set.lookupType({ namespaceUri: 'urn:t', localName: 'R' })).toBeUndefined();
  });

  it('breaks a base-type cycle without hanging', () => {
    const set = schemaSetFromXml(`<?xml version="1.0"?>
      <xs:schema xmlns:xs="${NS.XSD}" xmlns:t="urn:t" targetNamespace="urn:t">
        <xs:complexType name="A">
          <xs:complexContent><xs:extension base="t:B"><xs:sequence>
            <xs:element name="a" type="xs:string"/></xs:sequence></xs:extension></xs:complexContent>
        </xs:complexType>
        <xs:complexType name="B">
          <xs:complexContent><xs:extension base="t:A"><xs:sequence>
            <xs:element name="b" type="xs:string"/></xs:sequence></xs:extension></xs:complexContent>
        </xs:complexType>
      </xs:schema>`);
    const resolved = set.resolveContent(set.lookupType({ namespaceUri: 'urn:t', localName: 'A' }) as ComplexType);
    expect(localNames((resolved.particle as Sequence).particles).sort()).toEqual(['a', 'b']);
  });

  it('honours form="qualified" on an individual local element', () => {
    const set = schemaSetFromXml(`<?xml version="1.0"?>
      <xs:schema xmlns:xs="${NS.XSD}" targetNamespace="urn:t" elementFormDefault="unqualified">
        <xs:complexType name="C"><xs:sequence>
          <xs:element name="plain" type="xs:string"/>
          <xs:element name="qual" type="xs:string" form="qualified"/>
        </xs:sequence></xs:complexType>
      </xs:schema>`);
    const type = set.lookupType({ namespaceUri: 'urn:t', localName: 'C' }) as ComplexType;
    const particles = (type.content as { particle: Sequence }).particle.particles;
    expect((particles[0] as LocalElement).decl.name.namespaceUri).toBe('');
    expect((particles[1] as LocalElement).decl.name.namespaceUri).toBe('urn:t');
  });

  it('resolves unprefixed QName values against the in-scope default namespace, not the target namespace', () => {
    const set = schemaSetFromXml(`<?xml version="1.0"?>
      <xs:schema xmlns:xs="${NS.XSD}" xmlns="${NS.XSD}" targetNamespace="urn:t">
        <xs:element name="E" type="string"/>
      </xs:schema>`);
    expect(set.problems).toEqual([]);
    expect(set.lookupElement({ namespaceUri: 'urn:t', localName: 'E' })?.type).toEqual(q(NS.XSD, 'string'));
  });

  it('adopts the including namespace for a chameleon include', async () => {
    const bundle = await resolveDefinition(
      { location: new URL('chameleon-include/service.wsdl', `file://${craftedRoot}`).toString() },
      { fetchDocument: createDefaultFetchDocument() },
    );
    const set = buildSchemaSet(bundle);
    expect(set.namespaces).toContain('urn:wb:chameleon');
    expect(set.lookupType({ namespaceUri: 'urn:wb:chameleon', localName: 'PingCode' })).toBeDefined();
  });

  it('reports invalid-schema for unbound prefixes and malformed declarations', () => {
    const set = schemaSetFromXml(`<?xml version="1.0"?>
      <xs:schema xmlns:xs="${NS.XSD}" targetNamespace="urn:t">
        <xs:element name="E" type="nope:Thing"/>
        <xs:simpleType name="U"><xs:union memberTypes="nope:A"/></xs:simpleType>
        <xs:complexType name="Bad"><xs:complexContent/></xs:complexType>
        <xs:complexType name="Bad2"><xs:simpleContent/></xs:complexType>
        <xs:group name="G"><xs:group ref="xs:string"/></xs:group>
        <xs:element name="Junk"><xs:complexType><xs:sequence>
          <xs:notAParticle/></xs:sequence></xs:complexType></xs:element>
      </xs:schema>`);
    expect(new Set(set.problems.map((p) => p.code))).toEqual(new Set(['invalid-schema']));
    expect(set.lookupGroup({ namespaceUri: 'urn:t', localName: 'G' })).toBeUndefined();
    expect(set.lookupType({ namespaceUri: 'urn:t', localName: 'Bad' })?.kind).toBe('complexType');
    expect((set.lookupType({ namespaceUri: 'urn:t', localName: 'Bad' }) as ComplexType).content.kind).toBe('empty');
  });

  it('tolerates a bare simpleType, non-numeric occurs and qualified attribute form', () => {
    const set = schemaSetFromXml(`<?xml version="1.0"?>
      <xs:schema xmlns:xs="${NS.XSD}" targetNamespace="urn:t" attributeFormDefault="qualified">
        <xs:simpleType name="Bare"/>
        <xs:complexType name="C">
          <xs:sequence>
            <xs:element name="e" type="xs:string" minOccurs="x" maxOccurs="y"/>
          </xs:sequence>
          <xs:attribute name="q" type="xs:string"/>
        </xs:complexType>
      </xs:schema>`);
    expect(set.problems).toEqual([]);
    expect(expectSimple(set, 'urn:t', 'Bare').variety).toBe('atomic');
    const type = set.lookupType({ namespaceUri: 'urn:t', localName: 'C' }) as ComplexType;
    expect(((type.content as { particle: Sequence }).particle.particles[0] as LocalElement).occurs).toEqual({
      min: 1,
      max: 1,
    });
    expect(set.resolveContent(type).attributes[0]?.name).toEqual(q('urn:t', 'q'));
  });

  it('breaks group-reference cycles and honours prohibited attribute refs', () => {
    const set = schemaSetFromXml(`<?xml version="1.0"?>
      <xs:schema xmlns:xs="${NS.XSD}" xmlns:t="urn:t" targetNamespace="urn:t">
        <xs:group name="G"><xs:sequence>
          <xs:element name="g" type="xs:string"/>
          <xs:group ref="t:G"/>
        </xs:sequence></xs:group>
        <xs:attribute name="a" type="xs:string"/>
        <xs:attributeGroup name="AG">
          <xs:attribute ref="t:a" use="required" default="d"/>
          <xs:attributeGroup ref="t:AG"/>
        </xs:attributeGroup>
        <xs:complexType name="C">
          <xs:sequence><xs:group ref="t:G"/></xs:sequence>
          <xs:attributeGroup ref="t:AG"/>
          <xs:attribute ref="t:a" use="prohibited"/>
          <xs:attribute name="gone" use="prohibited"/>
        </xs:complexType>
      </xs:schema>`);
    expect(set.problems).toEqual([]);
    const resolved = set.resolveContent(set.lookupType({ namespaceUri: 'urn:t', localName: 'C' }) as ComplexType);
    const expanded = (resolved.particle as Sequence).particles[0] as Sequence;
    expect(localNames(expanded.particles)).toEqual(['g']);
    expect(resolved.attributes).toEqual([]);
  });

  it('keeps a choice particle as-is and reports element refs', () => {
    const set = schemaSetFromXml(`<?xml version="1.0"?>
      <xs:schema xmlns:xs="${NS.XSD}" xmlns:t="urn:t" targetNamespace="urn:t" elementFormDefault="qualified">
        <xs:element name="G" type="xs:string"/>
        <xs:complexType name="C">
          <xs:choice maxOccurs="unbounded">
            <xs:element ref="t:G"/>
          </xs:choice>
        </xs:complexType>
      </xs:schema>`);
    expect(set.problems).toEqual([]);
    const resolved = set.resolveContent(set.lookupType({ namespaceUri: 'urn:t', localName: 'C' }) as ComplexType);
    expect(resolved.particle?.kind).toBe('choice');
    expect((resolved.particle as Choice).occurs).toEqual({ min: 1, max: 'unbounded' });
  });

  it('stops at a simple-type restriction cycle when resolving simpleContent', () => {
    const set = schemaSetFromXml(`<?xml version="1.0"?>
      <xs:schema xmlns:xs="${NS.XSD}" xmlns:t="urn:t" targetNamespace="urn:t">
        <xs:simpleType name="S1"><xs:restriction base="t:S2"/></xs:simpleType>
        <xs:simpleType name="S2"><xs:restriction base="t:S1"/></xs:simpleType>
        <xs:complexType name="C"><xs:simpleContent>
          <xs:extension base="t:S1"/></xs:simpleContent></xs:complexType>
        <xs:complexType name="D"><xs:simpleContent>
          <xs:extension base="t:Nope"/></xs:simpleContent></xs:complexType>
        <xs:complexType name="E"><xs:simpleContent>
          <xs:extension base="t:C"/></xs:simpleContent></xs:complexType>
        <xs:complexType name="F"><xs:simpleContent>
          <xs:extension base="t:Plain"/></xs:simpleContent></xs:complexType>
        <xs:complexType name="Plain"><xs:sequence/></xs:complexType>
      </xs:schema>`);
    const base = (name: string) =>
      set.resolveContent(set.lookupType({ namespaceUri: 'urn:t', localName: name }) as ComplexType).simpleContentBase;
    expect(base('C')).toEqual(q('urn:t', 'S1'));
    expect(base('D')).toEqual(q('urn:t', 'Nope'));
    expect(base('E')).toEqual(q('urn:t', 'S1'));
    expect(base('F')).toEqual(q('urn:t', 'Plain'));
  });

  it('ignores non-schema input elements', () => {
    const doc = parseXml(`<root xmlns="urn:x"/>`, { location: 'x.xml' });
    const set = buildSchemaSet({ schemaElements: [doc.documentElement!] });
    expect(set.namespaces).toEqual([]);
    expect(set.problems).toEqual([]);
  });
});

describe('buildSchemaSet — public fixtures', () => {
  it.each([
    ['countryinfo', 'http://www.oorsprong.org/websamples.countryinfo', 'CountryCurrency'],
    ['calculator', 'http://tempuri.org/', 'Add'],
  ])('builds %s with no problems', async (name, ns, element) => {
    const definition = await parseWsdl(
      { location: `file:///fixtures/${name}/service.wsdl`, text: readPublicFixture(name) },
      {
        fetchDocument: () => Promise.reject(new Error('no fetch')),
        resolveImports: false,
      },
    );
    const set = buildSchemaSet(definition);
    expect(set.problems).toEqual([]);
    expect(set.lookupElement({ namespaceUri: ns, localName: element })).toBeDefined();
    expect(set.elements.size).toBeGreaterThan(4);
    expect(set.namespaces).toContain(ns);
  });

  it.each(['numberconversion', 'tempconvert'])('builds %s with no problems', async (name) => {
    const definition = await parseWsdl(
      { location: `file:///fixtures/${name}/service.wsdl`, text: readPublicFixture(name) },
      {
        fetchDocument: () => Promise.reject(new Error('no fetch')),
        resolveImports: false,
      },
    );
    const set = buildSchemaSet(definition);
    expect(set.problems).toEqual([]);
    expect(set.elements.size).toBeGreaterThan(0);
  });
});
