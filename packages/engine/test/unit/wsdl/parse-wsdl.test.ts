import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isWirebenchError } from '../../../src/errors.js';
import { findBinding, findMessage, findPortType, findService } from '../../../src/wsdl/model.js';
import { parseWsdl, parseWsdlDocument } from '../../../src/wsdl/parse-wsdl.js';
import { parseXml } from '../../../src/xml/parse.js';
import { readPublicFixture } from '../../helpers/fixtures.js';
import { toGoldenJson } from '../../helpers/golden.js';

const goldenDir = fileURLToPath(new URL('../../fixtures/wsdl-model/', import.meta.url));

function parseFixture(name: string) {
  const text = readPublicFixture(name);
  const doc = parseXml(text, { location: `${name}/service.wsdl` });
  return parseWsdlDocument(doc, `${name}/service.wsdl`);
}

/** Set to true locally to (re)write golden files after an intentional model change. */
const UPDATE_GOLDEN = process.env['UPDATE_WSDL_GOLDEN'] === '1';

function expectMatchesGolden(name: string, def: ReturnType<typeof parseFixture>): void {
  const json = toGoldenJson(def);
  const path = `${goldenDir}${name}.json`;
  if (UPDATE_GOLDEN) {
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  }
  const golden = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  expect(json).toEqual(golden);
}

describe('parseWsdlDocument — golden fixtures', () => {
  it('matches the golden model for calculator', () => {
    expectMatchesGolden('calculator', parseFixture('calculator'));
  });

  it('matches the golden model for tempconvert', () => {
    expectMatchesGolden('tempconvert', parseFixture('tempconvert'));
  });

  it('matches the golden model for numberconversion', () => {
    expectMatchesGolden('numberconversion', parseFixture('numberconversion'));
  });
});

describe('parseWsdlDocument — calculator facts', () => {
  const def = parseFixture('calculator');

  it('has two bindings: CalculatorSoap (1.1) and CalculatorSoap12 (1.2)', () => {
    expect(def.bindings).toHaveLength(2);
    const soap11 = findBinding(def, { namespaceUri: def.targetNamespace, localName: 'CalculatorSoap' });
    const soap12 = findBinding(def, { namespaceUri: def.targetNamespace, localName: 'CalculatorSoap12' });
    expect(soap11).toBeDefined();
    expect(soap12).toBeDefined();
    expect(soap11?.soapVersion).toBe('1.1');
    expect(soap11?.style).toBe('document');
    expect(soap11?.transport).toBe('http://schemas.xmlsoap.org/soap/http');
    expect(soap12?.soapVersion).toBe('1.2');
  });

  it('has an Add operation with soapAction http://tempuri.org/Add', () => {
    const soap11 = findBinding(def, { namespaceUri: def.targetNamespace, localName: 'CalculatorSoap' });
    const addOp = soap11?.operations.find((op) => op.name === 'Add');
    expect(addOp?.soapAction).toBe('http://tempuri.org/Add');
  });

  it('has ports with addresses', () => {
    const service = findService(def, { namespaceUri: def.targetNamespace, localName: 'Calculator' });
    expect(service?.ports).toHaveLength(2);
    for (const port of service?.ports ?? []) {
      expect(port.address).toBe('http://www.dneonline.com/calculator.asmx');
    }
  });

  it('exposes portType and message lookups', () => {
    const portType = findPortType(def, { namespaceUri: def.targetNamespace, localName: 'CalculatorSoap' });
    expect(portType?.operations.map((o) => o.name)).toEqual(['Add', 'Subtract', 'Multiply', 'Divide']);
    const message = findMessage(def, { namespaceUri: def.targetNamespace, localName: 'AddSoapIn' });
    expect(message?.parts).toEqual([
      { name: 'parameters', element: { namespaceUri: def.targetNamespace, localName: 'Add' } },
    ]);
  });
});

describe('parseWsdlDocument — countryinfo', () => {
  it('parses without error and has more than 20 operations', () => {
    const def = parseFixture('countryinfo');
    const operationCount = def.portTypes.reduce((sum, pt) => sum + pt.operations.length, 0);
    expect(operationCount).toBeGreaterThan(20);
  });
});

describe('parseWsdlDocument — errors', () => {
  it('throws not-a-wsdl for an XSD document', () => {
    const xsd = '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:x"/>';
    const doc = parseXml(xsd, { location: 'schema.xsd' });
    try {
      parseWsdlDocument(doc, 'schema.xsd');
      expect.fail('expected parseWsdlDocument to throw');
    } catch (e) {
      expect(isWirebenchError(e)).toBe(true);
      expect(isWirebenchError(e) && e.code).toBe('not-a-wsdl');
    }
  });

  it('throws wsdl-invalid when a required attribute is missing', () => {
    const wsdl = [
      '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" targetNamespace="urn:x">',
      '  <portType name="PT">',
      '    <operation name="Op">',
      '      <input/>',
      '    </operation>',
      '  </portType>',
      '</definitions>',
    ].join('\n');
    const doc = parseXml(wsdl, { location: 'broken.wsdl' });
    try {
      parseWsdlDocument(doc, 'broken.wsdl');
      expect.fail('expected parseWsdlDocument to throw');
    } catch (e) {
      expect(isWirebenchError(e)).toBe(true);
      expect(isWirebenchError(e) && e.code).toBe('wsdl-invalid');
    }
  });

  // Regression guards: `requireAttribute` (packages/engine/src/wsdl/dom-utils.ts)
  // already attaches `details.location`/`details.line`/`details.column` via
  // `getPosition`, and `parseWsdlDocument`'s `not-a-wsdl` throw already attaches
  // the same for the root element — these tests just pin that behavior down.
  it("throws wsdl-invalid with details.location and the offending element's line/column", () => {
    // <input/> on line 4 (1-indexed), missing its required "message" attribute.
    const wsdl = [
      '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" targetNamespace="urn:x">',
      '  <portType name="PT">',
      '    <operation name="Op">',
      '      <input/>',
      '    </operation>',
      '  </portType>',
      '</definitions>',
    ].join('\n');
    const doc = parseXml(wsdl, { location: 'broken.wsdl' });
    try {
      parseWsdlDocument(doc, 'broken.wsdl');
      expect.fail('expected parseWsdlDocument to throw');
    } catch (e) {
      expect(isWirebenchError(e)).toBe(true);
      if (!isWirebenchError(e)) {
        return;
      }
      expect(e.code).toBe('wsdl-invalid');
      expect(e.details).toMatchObject({ location: 'broken.wsdl' });
      expect((e.details as { line?: number }).line).toBe(4);
      expect((e.details as { column?: number }).column).toBeGreaterThan(0);
    }
  });

  it("throws not-a-wsdl with details.location and the root element's line/column", () => {
    // Root <xs:schema> starts on line 2 (1-indexed).
    const xsd = ['<?xml version="1.0"?>', '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"/>'].join('\n');
    const doc = parseXml(xsd, { location: 'schema.xsd' });
    try {
      parseWsdlDocument(doc, 'schema.xsd');
      expect.fail('expected parseWsdlDocument to throw');
    } catch (e) {
      expect(isWirebenchError(e)).toBe(true);
      if (!isWirebenchError(e)) {
        return;
      }
      expect(e.code).toBe('not-a-wsdl');
      expect(e.details).toMatchObject({ location: 'schema.xsd' });
      expect((e.details as { line?: number }).line).toBe(2);
      expect((e.details as { column?: number }).column).toBeGreaterThan(0);
    }
  });
});

describe('parseWsdl', () => {
  const fetchDocument = () => {
    throw new Error('fetchDocument should not be called when resolveImports is false');
  };

  it('parses a single document when resolveImports is false', async () => {
    const text = readPublicFixture('calculator');
    const def = await parseWsdl(
      { location: 'calculator/service.wsdl', text },
      { fetchDocument, resolveImports: false },
    );
    expect(def.services).toHaveLength(1);
  });

  it('resolves nested imports and merges the bundle', async () => {
    const craftedRoot = fileURLToPath(new URL('../../../../../fixtures/wsdl/crafted/nested-imports/', import.meta.url));
    const docs: Record<string, string> = {
      'service.wsdl': readFileSync(`${craftedRoot}service.wsdl`, 'utf-8'),
      'types.wsdl': readFileSync(`${craftedRoot}types.wsdl`, 'utf-8'),
      'schemas/common.xsd': readFileSync(`${craftedRoot}schemas/common.xsd`, 'utf-8'),
      'schemas/base.xsd': readFileSync(`${craftedRoot}schemas/base.xsd`, 'utf-8'),
    };
    const base = 'mem://nested-imports/';
    const fetchNested = (location: string) => {
      const key = location.slice(base.length);
      const text = docs[key];
      if (text === undefined) {
        return Promise.reject(new Error(`no fixture for ${location}`));
      }
      return Promise.resolve({ location, bytes: new TextEncoder().encode(text), text });
    };
    const def = await parseWsdl(
      { location: `${base}service.wsdl` },
      { fetchDocument: fetchNested, resolveImports: true },
    );
    expect(def.problems).toEqual([]);
    expect(def.schemaElements).toHaveLength(3);
    // Verify one element comes from types.wsdl (has targetNamespace 'urn:wb:nested-types')
    const fromTypesWsdl = def.schemaElements.find((el) => el.getAttribute('targetNamespace') === 'urn:wb:nested-types');
    expect(fromTypesWsdl).toBeDefined();
    const portType = def.portTypes.find((p) => p.name.localName === 'EchoPortType');
    expect(portType?.operations.map((o) => o.name)).toEqual(['Echo']);
  });
});

describe('parseWsdlDocument — soap:header', () => {
  it('parses a soap:header referencing a message and part', () => {
    const wsdl = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
             xmlns:tns="urn:x"
             xmlns:xs="http://www.w3.org/2001/XMLSchema"
             targetNamespace="urn:x">
  <message name="AuthHeader"><part name="token" type="xs:string"/></message>
  <message name="DoWorkIn"><part name="body" type="xs:string"/></message>
  <message name="DoWorkOut"><part name="body" type="xs:string"/></message>
  <portType name="PT">
    <operation name="DoWork">
      <input message="tns:DoWorkIn"/>
      <output message="tns:DoWorkOut"/>
    </operation>
  </portType>
  <binding name="B" type="tns:PT">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="DoWork">
      <soap:operation soapAction="urn:x/DoWork"/>
      <input>
        <soap:body use="literal"/>
        <soap:header message="tns:AuthHeader" part="token" use="literal"/>
      </input>
      <output><soap:body use="literal"/></output>
    </operation>
  </binding>
</definitions>`;
    const doc = parseXml(wsdl, { location: 'header.wsdl' });
    const def = parseWsdlDocument(doc, 'header.wsdl');
    const binding = def.bindings[0];
    const op = binding?.operations[0];
    expect(op?.input?.headers).toEqual([
      {
        message: { namespaceUri: 'urn:x', localName: 'AuthHeader' },
        part: 'token',
        use: 'literal',
        headerFaults: [],
      },
    ]);
  });
});

describe('parseWsdlDocument — rpc/encoded', () => {
  it('parses style rpc, use encoded, encodingStyle, and parameterOrder', () => {
    const wsdl = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
             xmlns:tns="urn:x"
             xmlns:xs="http://www.w3.org/2001/XMLSchema"
             targetNamespace="urn:x">
  <message name="AddIn">
    <part name="a" type="xs:int"/>
    <part name="b" type="xs:int"/>
  </message>
  <message name="AddOut"><part name="result" type="xs:int"/></message>
  <portType name="PT">
    <operation name="Add" parameterOrder="a b">
      <input message="tns:AddIn"/>
      <output message="tns:AddOut"/>
    </operation>
  </portType>
  <binding name="B" type="tns:PT">
    <soap:binding style="rpc" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="Add">
      <soap:operation soapAction="urn:x/Add" style="rpc"/>
      <input>
        <soap:body use="encoded" namespace="urn:x" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/>
      </input>
      <output>
        <soap:body use="encoded" namespace="urn:x" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/>
      </output>
    </operation>
  </binding>
</definitions>`;
    const doc = parseXml(wsdl, { location: 'rpc.wsdl' });
    const def = parseWsdlDocument(doc, 'rpc.wsdl');
    const portType = def.portTypes[0];
    expect(portType?.operations[0]?.parameterOrder).toEqual(['a', 'b']);
    const binding = def.bindings[0];
    expect(binding?.style).toBe('rpc');
    const op = binding?.operations[0];
    expect(op?.style).toBe('rpc');
    expect(op?.input?.body).toEqual({
      use: 'encoded',
      namespace: 'urn:x',
      encodingStyle: 'http://schemas.xmlsoap.org/soap/encoding/',
    });
  });
});

describe('parseWsdlDocument — unprefixed QName resolution', () => {
  it('resolves an unprefixed binding type to the in-scope default namespace (the WSDL namespace)', () => {
    // Default namespace on <definitions> is the WSDL namespace itself; "MyPortType"
    // has no prefix, so per the controller's ruling it resolves to whatever default
    // namespace is in scope (here, the WSDL namespace), not targetNamespace.
    const wsdl = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" targetNamespace="urn:x">
  <portType name="MyPortType"/>
  <binding name="B" type="MyPortType">
  </binding>
</definitions>`;
    const doc = parseXml(wsdl, { location: 'default-ns.wsdl' });
    const def = parseWsdlDocument(doc, 'default-ns.wsdl');
    expect(def.bindings[0]?.type).toEqual({
      namespaceUri: 'http://schemas.xmlsoap.org/wsdl/',
      localName: 'MyPortType',
    });
  });

  it('falls back to targetNamespace for an unprefixed message ref when no default namespace is declared', () => {
    const wsdl = `<?xml version="1.0"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" targetNamespace="urn:x">
  <wsdl:message name="MyMsg"/>
  <wsdl:portType name="PT">
    <wsdl:operation name="Op">
      <wsdl:input message="MyMsg"/>
    </wsdl:operation>
  </wsdl:portType>
</wsdl:definitions>`;
    const doc = parseXml(wsdl, { location: 'no-default-ns.wsdl' });
    const def = parseWsdlDocument(doc, 'no-default-ns.wsdl');
    expect(def.portTypes[0]?.operations[0]?.input?.message).toEqual({ namespaceUri: 'urn:x', localName: 'MyMsg' });
  });

  it('resolves an unprefixed part type to the XSD namespace when declared as the default namespace', () => {
    const wsdl = `<?xml version="1.0"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" targetNamespace="urn:x">
  <wsdl:message name="MyMsg">
    <wsdl:part name="p" xmlns="http://www.w3.org/2001/XMLSchema" type="string"/>
  </wsdl:message>
</wsdl:definitions>`;
    const doc = parseXml(wsdl, { location: 'xsd-default-ns.wsdl' });
    const def = parseWsdlDocument(doc, 'xsd-default-ns.wsdl');
    expect(def.messages[0]?.parts[0]?.type).toEqual({
      namespaceUri: 'http://www.w3.org/2001/XMLSchema',
      localName: 'string',
    });
  });
});

describe('parseWsdlDocument — imports, faults, and remaining binding shapes', () => {
  it('parses wsdl:import, fault documentation, soap:body parts, headerfault, binding fault use, and a portless port', () => {
    const wsdl = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
             xmlns:http="http://schemas.xmlsoap.org/wsdl/http/"
             xmlns:tns="urn:x"
             xmlns:xs="http://www.w3.org/2001/XMLSchema"
             targetNamespace="urn:x">
  <import namespace="urn:shared" location="shared.wsdl"/>
  <message name="AuthHeader"><part name="token" type="xs:string"/></message>
  <message name="ErrorInfo"><part name="detail" type="xs:string"/></message>
  <message name="DoWorkIn"><part name="a" type="xs:string"/><part name="b" type="xs:string"/></message>
  <message name="DoWorkOut"><part name="body" type="xs:string"/></message>
  <portType name="PT">
    <operation name="DoWork">
      <input message="tns:DoWorkIn"/>
      <output message="tns:DoWorkOut"/>
      <fault name="Failure" message="tns:ErrorInfo">
        <documentation>Thrown when work fails.</documentation>
      </fault>
    </operation>
  </portType>
  <binding name="B" type="tns:PT">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="DoWork">
      <soap:operation soapAction="urn:x/DoWork"/>
      <input>
        <soap:body use="literal" parts="a b"/>
        <soap:header message="tns:AuthHeader" part="token" use="literal">
          <soap:headerfault message="tns:ErrorInfo" part="detail" use="literal"/>
        </soap:header>
      </input>
      <output><soap:body use="literal"/></output>
      <fault name="Failure"><soap:fault name="Failure" use="encoded"/></fault>
    </operation>
  </binding>
  <service name="S">
    <port name="NoAddressPort" binding="tns:B"/>
  </service>
</definitions>`;
    const doc = parseXml(wsdl, { location: 'full.wsdl' });
    const def = parseWsdlDocument(doc, 'full.wsdl');

    expect(def.imports).toEqual([{ namespace: 'urn:shared', location: 'shared.wsdl' }]);

    const portType = def.portTypes[0];
    expect(portType?.operations[0]?.faults[0]).toEqual({
      name: 'Failure',
      message: { namespaceUri: 'urn:x', localName: 'ErrorInfo' },
      documentation: 'Thrown when work fails.',
    });

    const binding = def.bindings[0];
    const op = binding?.operations[0];
    expect(op?.input?.body.parts).toEqual(['a', 'b']);
    expect(op?.input?.headers[0]?.headerFaults).toEqual([
      { message: { namespaceUri: 'urn:x', localName: 'ErrorInfo' }, part: 'detail', use: 'literal' },
    ]);
    expect(op?.faults).toEqual([{ name: 'Failure', use: 'encoded' }]);

    const service = def.services[0];
    expect(service?.ports[0]).toEqual({
      name: 'NoAddressPort',
      binding: { namespaceUri: 'urn:x', localName: 'B' },
    });
  });
});

describe('parseWsdlDocument — namespaceDeclarations', () => {
  it('records every xmlns:* declared on the definitions element', () => {
    const def = parseFixture('calculator');
    expect(def.namespaceDeclarations['tns']).toBe('http://tempuri.org/');
    expect(def.namespaceDeclarations['soap']).toBe('http://schemas.xmlsoap.org/wsdl/soap/');
    expect(def.namespaceDeclarations['s']).toBe('http://www.w3.org/2001/XMLSchema');
    expect(def.namespaceDeclarations['wsdl']).toBe('http://schemas.xmlsoap.org/wsdl/');
  });

  it('excludes the default declaration and ordinary attributes', () => {
    const doc = parseXml(
      '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:t="urn:x" targetNamespace="urn:x" name="S"/>',
      { location: 'inline.wsdl' },
    );
    const def = parseWsdlDocument(doc, 'inline.wsdl');
    expect(def.namespaceDeclarations).toEqual({ t: 'urn:x' });
  });
});
