import { describe, expect, it } from 'vitest';
import { parseXml } from '../../../src/xml/parse.js';
import { buildSchemaSet } from '../../../src/xsd/schema-set.js';
import type { SchemaSet } from '../../../src/xsd/schema-set.js';
import {
  attributesAllowedAt,
  childrenAllowedAt,
  completionContextAt,
  declarationOf,
  elementPathAt,
} from '../../../src/xsd/locate.js';

const TEM = 'http://tempuri.org/';
const q = (ns: string, local: string) => ({ namespaceUri: ns, localName: local });

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

const calculatorSchema = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:tns="${TEM}" targetNamespace="${TEM}" elementFormDefault="qualified">
  <xs:element name="Add">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="intA" type="xs:int"/>
        <xs:element name="intB" type="xs:int"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const envelope = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="${TEM}">
   <soapenv:Header/>
   <soapenv:Body>
      <tem:Add>
         <tem:intA>1</tem:intA>
         <tem:intB>2</tem:intB>
      </tem:Add>
   </soapenv:Body>
</soapenv:Envelope>`;

describe('elementPathAt', () => {
  it('resolves the ancestor chain inside <tem:Add>', () => {
    const offset = envelope.indexOf('<tem:intA') + 1;
    const path = elementPathAt(envelope, offset);
    expect(path).toEqual([
      q('http://schemas.xmlsoap.org/soap/envelope/', 'Envelope'),
      q('http://schemas.xmlsoap.org/soap/envelope/', 'Body'),
      q(TEM, 'Add'),
    ]);
  });

  it('is tolerant of an unfinished tag at the cursor', () => {
    const text = `${envelope.slice(0, envelope.indexOf('<tem:intA'))}<tem:`;
    const path = elementPathAt(text, text.length);
    expect(path).toEqual([
      q('http://schemas.xmlsoap.org/soap/envelope/', 'Envelope'),
      q('http://schemas.xmlsoap.org/soap/envelope/', 'Body'),
      q(TEM, 'Add'),
    ]);
  });
});

describe('childrenAllowedAt', () => {
  it('offers intA/intB inside <tem:Add>', () => {
    const set = schemaSetFromXml(calculatorSchema);
    const children = childrenAllowedAt(set, [q(TEM, 'Add')]);
    expect(children.map((c) => c.name.localName)).toEqual(['intA', 'intB']);
  });

  it('returns [] for an unknown path', () => {
    const set = schemaSetFromXml(calculatorSchema);
    expect(childrenAllowedAt(set, [q(TEM, 'DoesNotExist')])).toEqual([]);
    expect(childrenAllowedAt(set, [])).toEqual([]);
  });

  it('includes choice children and substitution group members', () => {
    const schema = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:tns="${TEM}" targetNamespace="${TEM}" elementFormDefault="qualified">
      <xs:element name="Base" type="xs:string"/>
      <xs:element name="Derived" substitutionGroup="tns:Base" type="xs:string"/>
      <xs:element name="Root">
        <xs:complexType>
          <xs:choice>
            <xs:element ref="tns:Base"/>
            <xs:element name="Other" type="xs:string"/>
          </xs:choice>
        </xs:complexType>
      </xs:element>
    </xs:schema>`;
    const set = schemaSetFromXml(schema);
    const children = childrenAllowedAt(set, [q(TEM, 'Root')]);
    expect(children.map((c) => c.name.localName).sort()).toEqual(['Base', 'Derived', 'Other']);
  });
});

describe('attributesAllowedAt', () => {
  it('lists attributes on the resolved element', () => {
    const schema = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:tns="${TEM}" targetNamespace="${TEM}" elementFormDefault="qualified">
      <xs:element name="Widget">
        <xs:complexType>
          <xs:attribute name="id" type="xs:string" use="required"/>
        </xs:complexType>
      </xs:element>
    </xs:schema>`;
    const set = schemaSetFromXml(schema);
    const attrs = attributesAllowedAt(set, [q(TEM, 'Widget')]);
    expect(attrs.map((a) => a.name.localName)).toEqual(['id']);
  });
});

describe('declarationOf', () => {
  it('reports the element declaration and its source location', () => {
    const set = schemaSetFromXml(calculatorSchema);
    const result = declarationOf(set, [q(TEM, 'Add')]);
    expect(result?.element.name).toEqual(q(TEM, 'Add'));
    expect(result?.source.location).toBe('<inline>');
    expect(result?.source.line).toBeGreaterThan(0);
  });

  it('is undefined for an unresolvable path', () => {
    const set = schemaSetFromXml(calculatorSchema);
    expect(declarationOf(set, [q(TEM, 'Nope')])).toBeUndefined();
  });
});

describe('completionContextAt', () => {
  it('reports the partial name, prefixes and replace range when typing "<" inside <tem:Add>', () => {
    const tagStart = envelope.indexOf('<tem:intA');
    const cursor = tagStart + '<tem:i'.length;
    const ctx = completionContextAt(envelope, cursor);
    expect(ctx).toBeDefined();
    expect(ctx?.partial).toBe('tem:i');
    expect(ctx?.path).toEqual([
      q('http://schemas.xmlsoap.org/soap/envelope/', 'Envelope'),
      q('http://schemas.xmlsoap.org/soap/envelope/', 'Body'),
      q(TEM, 'Add'),
    ]);
    expect(ctx?.prefixes.tem).toBe(TEM);
    expect(envelope.slice(ctx?.replaceRange.start, ctx?.replaceRange.end)).toBe('tem:intA');
  });

  it('is undefined when the cursor is not right after an open "<"', () => {
    expect(completionContextAt('<a>text</a>', 5)).toBeUndefined();
  });

  it('is undefined right after "<" alone with no partial name typed still resolves with empty partial', () => {
    const ctx = completionContextAt('<a><', 4);
    expect(ctx?.partial).toBe('');
    expect(ctx?.path).toEqual([q('', 'a')]);
  });
});
