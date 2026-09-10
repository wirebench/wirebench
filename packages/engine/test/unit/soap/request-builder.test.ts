import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseXml } from '../../../src/xml/parse.js';
import { NS } from '../../../src/xml/namespaces.js';
import { createDefaultFetchDocument } from '../../../src/wsdl/fetch.js';
import { parseWsdl } from '../../../src/wsdl/parse-wsdl.js';
import { buildSchemaSet } from '../../../src/xsd/schema-set.js';
import type { WsdlDefinition } from '../../../src/wsdl/model.js';
import type { QName } from '../../../src/wsdl/qname.js';
import { detectEnvelopeVersion } from '../../../src/soap/envelope.js';
import { buildEmptyRequest, buildSampleRequest } from '../../../src/soap/request-builder.js';
import type { GeneratedRequest, RequestBuildInput } from '../../../src/soap/request-builder.js';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const goldenDir = `${repoRoot}packages/engine/test/fixtures/envelopes/`;

/** Loads a fixture WSDL (`public/<name>` or `crafted/<name>`) and compiles its schemas. */
async function load(relative: string): Promise<RequestBuildInput> {
  const location = `${repoRoot}fixtures/wsdl/${relative}/service.wsdl`;
  const definition = await parseWsdl(
    { location, text: readFileSync(location, 'utf-8') },
    { fetchDocument: createDefaultFetchDocument(), resolveImports: true },
  );
  return { definition, schemaSet: buildSchemaSet(definition) };
}

/** Builds one operation of one binding named by its local name in the WSDL's target namespace. */
function build(input: RequestBuildInput, binding: string, operation: string): GeneratedRequest {
  return buildSampleRequest(input, {
    bindingName: { namespaceUri: input.definition.targetNamespace, localName: binding },
    operationName: operation,
  });
}

function golden(name: string): string {
  return readFileSync(`${goldenDir}${name}`, 'utf-8').replace(/\n$/, '');
}

/** Every binding operation of every SOAP binding in a definition. */
function soapOperations(definition: WsdlDefinition): { binding: string; operation: string }[] {
  return definition.bindings
    .filter((binding) => binding.soapVersion !== 'none')
    .flatMap((binding) =>
      binding.operations.map((operation) => ({ binding: binding.name.localName, operation: operation.name })),
    );
}

const fixtures: Record<string, RequestBuildInput> = {};

beforeAll(async () => {
  for (const name of [
    'public/calculator',
    'public/numberconversion',
    'public/countryinfo',
    'public/tempconvert',
    'crafted/rpc-literal',
    'crafted/rpc-encoded',
    'crafted/soap-headers',
  ]) {
    fixtures[name] = await load(name);
  }
});

/** `fixtures[name]`, asserted present (the record is index-checked). */
function fixture(name: string): RequestBuildInput {
  const input = fixtures[name];
  if (input === undefined) {
    throw new Error(`fixture ${name} was not loaded`);
  }
  return input;
}

describe('buildSampleRequest golden envelopes', () => {
  it('Calculator Add over the SOAP 1.1 binding', () => {
    const request = build(fixture('public/calculator'), 'CalculatorSoap', 'Add');
    expect(request.envelopeXml).toBe(golden('calculator-add-1.1.xml'));
    expect(request.problems).toEqual([]);
    expect(request.soapVersion).toBe('1.1');
    expect(request.soapAction).toBe('http://tempuri.org/Add');
    expect(request.contentType).toBe('text/xml;charset=UTF-8');
    expect(request.headers).toEqual({ SOAPAction: '"http://tempuri.org/Add"' });
  });

  it('Calculator Add over the SOAP 1.2 binding', () => {
    const request = build(fixture('public/calculator'), 'CalculatorSoap12', 'Add');
    expect(request.envelopeXml).toBe(golden('calculator-add-1.2.xml'));
    expect(request.problems).toEqual([]);
    expect(request.soapVersion).toBe('1.2');
    expect(request.contentType).toBe('application/soap+xml;charset=UTF-8;action="http://tempuri.org/Add"');
    expect(request.headers).toEqual({});
  });

  it('NumberConversion NumberToWords, with a mnemonic prefix from the namespace', () => {
    const request = build(fixture('public/numberconversion'), 'NumberConversionSoapBinding', 'NumberToWords');
    expect(request.envelopeXml).toBe(golden('numberconversion-numbertowords.xml'));
    // `http://www.dataaccess.com/webservicesserver/` → last path segment → `web`.
    expect(request.envelopeXml).toContain('xmlns:web="http://www.dataaccess.com/webservicesserver/"');
    expect(request.envelopeXml).toContain('<web:NumberToWords>');
    expect(request.problems).toEqual([]);
    // The binding declares soapAction="", which SOAP 1.1 still sends, quoted.
    expect(request.headers).toEqual({ SOAPAction: '""' });
  });

  it('rpc/literal Multiply orders accessors by parameterOrder and leaves them unqualified', () => {
    const request = build(fixture('crafted/rpc-literal'), 'RpcLiteralBinding', 'Multiply');
    expect(request.envelopeXml).toBe(golden('rpc-literal-multiply.xml'));
    expect(request.problems).toEqual([]);
    const body = request.envelopeXml.slice(request.envelopeXml.indexOf('<rpc:Multiply>'));
    // parameterOrder="b a"; `opts` is unnamed there and therefore comes last.
    expect(body.indexOf('<b>')).toBeLessThan(body.indexOf('<a>'));
    expect(body.indexOf('<a>')).toBeLessThan(body.indexOf('<opts>'));
    // Accessors are unprefixed; only the operation wrapper is namespaced.
    expect(body).toContain('<b>?</b>');
    expect(body).not.toContain('<rpc:b>');
  });

  it('rpc/encoded Sum carries encodingStyle, xsi:type and a soapenc array', () => {
    const request = build(fixture('crafted/rpc-encoded'), 'RpcEncodedBinding', 'Sum');
    expect(request.envelopeXml).toBe(golden('rpc-encoded-sum.xml'));
    expect(request.problems).toEqual([]);
    expect(request.envelopeXml).toContain(`<rpc:Sum soapenv:encodingStyle="${NS.SOAP11_ENC}">`);
    expect(request.envelopeXml).toContain('<values soapenc:arrayType="xsd:int[1]">');
    expect(request.envelopeXml).toContain('<label xsi:type="xsd:string">?</label>');
    for (const uri of [NS.XSI, NS.XSD, NS.SOAP11_ENC]) {
      expect(request.envelopeXml.split('\n')[0]).toContain(`="${uri}"`);
    }
  });

  it('soap-headers Echo puts both header parts in soapenv:Header', () => {
    const request = build(fixture('crafted/soap-headers'), 'SoapHeadersBinding', 'Echo');
    expect(request.envelopeXml).toBe(golden('soap-headers-echo.xml'));
    expect(request.problems).toEqual([]);
    expect(request.envelopeXml.split('\n')[0]).toContain(`xmlns:soapenv="${NS.SOAP12_ENV}"`);
    const header = request.envelopeXml.slice(
      request.envelopeXml.indexOf('<soapenv:Header>'),
      request.envelopeXml.indexOf('</soapenv:Header>'),
    );
    expect(header).toContain('<hea:AuthHeader>');
    expect(header).toContain('<hea:TraceHeader>?</hea:TraceHeader>');
    // The body carries only the part `soap12:body/@parts` names.
    expect(request.envelopeXml).toContain('<hea:Echo>');
    expect(request.contentType).toBe('application/soap+xml;charset=UTF-8;action="urn:wb:headers:Echo"');
  });

  it('soap-headers Legacy names a type-only document part after the part itself', () => {
    const request = build(fixture('crafted/soap-headers'), 'SoapHeadersBinding', 'Legacy');
    expect(request.envelopeXml).toBe(golden('soap-headers-legacy.xml'));
    // Non-WS-I, but not a problem: SoapUI does the same.
    expect(request.problems).toEqual([]);
    expect(request.envelopeXml).toContain('<payload>');
  });
});

describe('buildSampleRequest options', () => {
  it('honours caller-supplied prefixes', () => {
    const request = buildSampleRequest(
      fixture('public/calculator'),
      { bindingName: { namespaceUri: 'http://tempuri.org/', localName: 'CalculatorSoap' }, operationName: 'Add' },
      { prefixes: { 'http://tempuri.org/': 'calc' } },
    );
    expect(request.envelopeXml).toContain('xmlns:calc="http://tempuri.org/"');
    expect(request.envelopeXml).toContain('<calc:Add>');
  });

  it('honours a custom indent and the skipSoapAction flag', () => {
    const request = buildSampleRequest(
      fixture('public/calculator'),
      { bindingName: { namespaceUri: 'http://tempuri.org/', localName: 'CalculatorSoap' }, operationName: 'Add' },
      undefined,
      { indent: '  ', skipSoapAction: true },
    );
    expect(request.envelopeXml).toContain('\n  <soapenv:Body>\n    <tem:Add>');
    expect(request.headers).toEqual({});
    expect(request.soapAction).toBe('http://tempuri.org/Add');
  });

  it('emits optional elements and sample values when asked', () => {
    const request = buildSampleRequest(
      fixture('public/calculator'),
      { bindingName: { namespaceUri: 'http://tempuri.org/', localName: 'CalculatorSoap' }, operationName: 'Add' },
      { sampleValues: true },
    );
    expect(request.envelopeXml).not.toContain('<tem:intA>?</tem:intA>');
  });
});

describe('buildSampleRequest problems', () => {
  it('reports an unknown binding and still returns an empty SOAP 1.1 envelope', () => {
    const request = build(fixture('public/calculator'), 'NoSuchBinding', 'Add');
    expect(request.problems.map((p) => p.code)).toEqual(['unknown-binding']);
    expect(request.soapVersion).toBe('1.1');
    expect(request.envelopeXml).toContain('<soapenv:Body/>');
    expect(request.envelopeXml).toContain('<soapenv:Header/>');
  });

  it('reports an unknown operation, keeping the binding version', () => {
    const request = build(fixture('public/calculator'), 'CalculatorSoap12', 'Nope');
    expect(request.problems.map((p) => p.code)).toEqual(['unknown-operation']);
    expect(request.soapVersion).toBe('1.2');
    expect(request.envelopeXml).toContain('<soapenv:Body/>');
    expect(request.soapAction).toBeUndefined();
  });

  it('reports a non-SOAP binding as unsupported', () => {
    const request = build(fixture('public/tempconvert'), 'TempConvertHttpPost', 'FahrenheitToCelsius');
    expect(request.problems.map((p) => p.code)).toEqual(['unsupported-binding']);
    expect(request.soapVersion).toBe('1.1');
    expect(request.envelopeXml).toContain('<soapenv:Body/>');
  });

  it('reports a soap:body part the message does not declare', () => {
    const input = fixture('crafted/soap-headers');
    const patched: RequestBuildInput = {
      ...input,
      definition: {
        ...input.definition,
        bindings: input.definition.bindings.map((binding) => ({
          ...binding,
          operations: binding.operations.map((operation) =>
            operation.name !== 'Echo' || operation.input === undefined
              ? operation
              : { ...operation, input: { ...operation.input, body: { ...operation.input.body, parts: ['ghost'] } } },
          ),
        })),
      },
    };
    const request = build(patched, 'SoapHeadersBinding', 'Echo');
    expect(request.problems.map((p) => p.code)).toEqual(['missing-part']);
    expect(request.envelopeXml).toContain('<soapenv:Body/>');
  });

  it('reports a binding whose portType is missing', () => {
    const input = fixture('public/calculator');
    const patched: RequestBuildInput = { ...input, definition: { ...input.definition, portTypes: [] } };
    const request = build(patched, 'CalculatorSoap', 'Add');
    expect(request.problems.map((p) => p.code)).toEqual(['missing-portType']);
    expect(request.envelopeXml).toContain('<soapenv:Body/>');
  });

  it('reports an operation whose input message is missing', () => {
    const input = fixture('public/calculator');
    const patched: RequestBuildInput = { ...input, definition: { ...input.definition, messages: [] } };
    const request = build(patched, 'CalculatorSoap', 'Add');
    expect(request.problems.map((p) => p.code)).toEqual(['missing-message']);
  });

  it('reports a part whose element is not declared in any schema', () => {
    const input = fixture('public/calculator');
    const patched: RequestBuildInput = {
      ...input,
      definition: {
        ...input.definition,
        messages: input.definition.messages.map((message) =>
          message.name.localName !== 'AddSoapIn'
            ? message
            : {
                ...message,
                parts: [{ name: 'parameters', element: { namespaceUri: 'http://tempuri.org/', localName: 'Ghost' } }],
              },
        ),
      },
    };
    const request = build(patched, 'CalculatorSoap', 'Add');
    expect(request.problems.map((p) => p.code)).toEqual(['unknown-element']);
    expect(request.envelopeXml).toContain('<soapenv:Body/>');
  });

  it('reports a part whose type is not declared, and still emits a placeholder', () => {
    const input = fixture('crafted/rpc-literal');
    const patched: RequestBuildInput = {
      ...input,
      definition: {
        ...input.definition,
        messages: input.definition.messages.map((message) =>
          message.name.localName !== 'MultiplyRequest'
            ? message
            : { ...message, parts: [{ name: 'a', type: { namespaceUri: 'urn:wb:rpclit', localName: 'Ghost' } }] },
        ),
      },
    };
    const request = build(patched, 'RpcLiteralBinding', 'Multiply');
    expect(request.problems.map((p) => p.code)).toEqual(['unknown-type']);
    expect(request.envelopeXml).toContain('<a>?</a>');
  });

  it('reports a part declaring neither an element nor a type, in a body and in a header', () => {
    const input = fixture('crafted/soap-headers');
    const patched: RequestBuildInput = {
      ...input,
      definition: {
        ...input.definition,
        messages: input.definition.messages.map((message) =>
          message.name.localName !== 'EchoRequest'
            ? message
            : { ...message, parts: [{ name: 'body' }, { name: 'auth' }] },
        ),
      },
    };
    const request = build(patched, 'SoapHeadersBinding', 'Echo');
    expect(request.problems.map((p) => p.code)).toEqual(['missing-part', 'missing-part']);
  });

  it('reports a soap:header naming an unknown message or an unknown part', () => {
    const input = fixture('crafted/soap-headers');
    const patched: RequestBuildInput = {
      ...input,
      definition: {
        ...input.definition,
        bindings: input.definition.bindings.map((binding) => ({
          ...binding,
          operations: binding.operations.map((operation) =>
            operation.name !== 'Echo' || operation.input === undefined
              ? operation
              : {
                  ...operation,
                  input: {
                    ...operation.input,
                    headers: [
                      {
                        message: { namespaceUri: 'urn:wb:headers', localName: 'Ghost' },
                        part: 'x',
                        use: 'literal' as const,
                        headerFaults: [],
                      },
                      {
                        message: { namespaceUri: 'urn:wb:headers', localName: 'TraceMessage' },
                        part: 'ghost',
                        use: 'literal' as const,
                        headerFaults: [],
                      },
                    ],
                  },
                },
          ),
        })),
      },
    };
    const request = build(patched, 'SoapHeadersBinding', 'Echo');
    expect(request.problems.map((p) => p.code)).toEqual(['missing-message', 'missing-part']);
    expect(request.envelopeXml).toContain('<soapenv:Header/>');
  });

  it('marks an encoded header with encodingStyle', () => {
    const input = fixture('crafted/soap-headers');
    const patched: RequestBuildInput = {
      ...input,
      definition: {
        ...input.definition,
        bindings: input.definition.bindings.map((binding) => ({
          ...binding,
          operations: binding.operations.map((operation) =>
            operation.name !== 'Echo' || operation.input === undefined
              ? operation
              : {
                  ...operation,
                  input: {
                    ...operation.input,
                    headers: operation.input.headers.map((header) => ({ ...header, use: 'encoded' as const })),
                  },
                },
          ),
        })),
      },
    };
    const request = build(patched, 'SoapHeadersBinding', 'Echo');
    expect(request.envelopeXml).toContain(`<hea:AuthHeader soapenv:encodingStyle="${NS.SOAP11_ENC}">`);
    expect(request.envelopeXml).toContain(`<hea:TraceHeader soapenv:encodingStyle="${NS.SOAP11_ENC}">?`);
  });
});

describe('buildEmptyRequest', () => {
  it('returns an empty envelope with the operation transport metadata', () => {
    const request = buildEmptyRequest(fixture('public/calculator'), {
      bindingName: { namespaceUri: 'http://tempuri.org/', localName: 'CalculatorSoap' },
      operationName: 'Add',
    });
    expect(request.envelopeXml).toBe(
      [
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">',
        '   <soapenv:Header/>',
        '   <soapenv:Body/>',
        '</soapenv:Envelope>',
      ].join('\n'),
    );
    expect(request.soapVersion).toBe('1.1');
    expect(request.soapAction).toBe('http://tempuri.org/Add');
    expect(request.contentType).toBe('text/xml;charset=UTF-8');
    expect(request.headers).toEqual({ SOAPAction: '"http://tempuri.org/Add"' });
    expect(request.problems).toEqual([]);
  });

  it('reports the same problems as a sample request for an unknown operation', () => {
    const request = buildEmptyRequest(fixture('public/calculator'), {
      bindingName: { namespaceUri: 'http://tempuri.org/', localName: 'CalculatorSoap' },
      operationName: 'Nope',
    });
    expect(request.problems.map((p) => p.code)).toEqual(['unknown-operation']);
  });
});

describe('every SOAP operation of every fixture', () => {
  it('builds with no problems, is well-formed, and reports the right version', () => {
    for (const name of [
      'public/calculator',
      'public/numberconversion',
      'public/countryinfo',
      'public/tempconvert',
      'crafted/rpc-literal',
      'crafted/rpc-encoded',
      'crafted/soap-headers',
    ]) {
      const input = fixture(name);
      for (const { binding, operation } of soapOperations(input.definition)) {
        const request = build(input, binding, operation);
        expect(request.problems, `${name} ${binding}.${operation}`).toEqual([]);
        const doc = parseXml(request.envelopeXml, { location: `${binding}.${operation}` });
        expect(detectEnvelopeVersion(doc), `${name} ${binding}.${operation}`).toBe(request.soapVersion);
      }
    }
  });

  it('is deterministic', () => {
    const input = fixture('public/countryinfo');
    for (const { binding, operation } of soapOperations(input.definition)) {
      expect(build(input, binding, operation).envelopeXml).toBe(build(input, binding, operation).envelopeXml);
    }
  });
});

describe('rpc accessor edge cases', () => {
  /** Replaces the parts of the rpc-encoded `SumRequest` message. */
  function withSumParts(input: RequestBuildInput, parts: readonly { name: string; type?: QName }[]): RequestBuildInput {
    return {
      ...input,
      definition: {
        ...input.definition,
        messages: input.definition.messages.map((message) =>
          message.name.localName === 'SumRequest' ? { ...message, parts } : message,
        ),
      },
    };
  }

  it('emits a self-closing wrapper when the operation has no parts', () => {
    const request = build(withSumParts(fixture('crafted/rpc-encoded'), []), 'RpcEncodedBinding', 'Sum');
    expect(request.problems).toEqual([]);
    expect(request.envelopeXml).toContain(`<rpc:Sum soapenv:encodingStyle="${NS.SOAP11_ENC}"/>`);
  });

  it('reports an rpc part declaring neither an element nor a type', () => {
    const request = build(
      withSumParts(fixture('crafted/rpc-encoded'), [{ name: 'values' }]),
      'RpcEncodedBinding',
      'Sum',
    );
    expect(request.problems.map((p) => p.code)).toEqual(['missing-part']);
  });

  it('does not put xsi:type on a complex-typed encoded accessor', () => {
    // rpc-literal's `opts` part is complex-typed; force its body to `encoded`.
    const input = fixture('crafted/rpc-literal');
    const patched: RequestBuildInput = {
      ...input,
      definition: {
        ...input.definition,
        bindings: input.definition.bindings.map((binding) => ({
          ...binding,
          operations: binding.operations.map((operation) =>
            operation.input === undefined
              ? operation
              : { ...operation, input: { ...operation.input, body: { ...operation.input.body, use: 'encoded' } } },
          ),
        })),
      },
    };
    const request = build(patched, 'RpcLiteralBinding', 'Multiply');
    expect(request.envelopeXml).toContain('<b xsi:type="xsd:int">?</b>');
    // A complex accessor is described by the schema, not by an xsi:type.
    expect(request.envelopeXml).toContain('<opts>\n');
  });

  it('emits an rpc part declared with an element as the element itself', () => {
    const input = fixture('crafted/rpc-literal');
    const patched: RequestBuildInput = {
      ...input,
      definition: {
        ...input.definition,
        messages: input.definition.messages.map((message) =>
          message.name.localName !== 'MultiplyRequest'
            ? message
            : { ...message, parts: [{ name: 'a', element: { namespaceUri: 'urn:wb:rpclit', localName: 'Ghost' } }] },
        ),
      },
    };
    // The element does not exist in the schema, which is what the problem reports.
    expect(build(patched, 'RpcLiteralBinding', 'Multiply').problems.map((p) => p.code)).toEqual(['unknown-element']);
  });
});
