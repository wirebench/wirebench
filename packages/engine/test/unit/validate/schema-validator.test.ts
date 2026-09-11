import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { importDefinition } from '../../../src/import.js';
import type { ImportResult } from '../../../src/types.js';
import { validateAgainstSchemaSet } from '../../../src/validate/schema-validator.js';
import type { ValidationProblem } from '../../../src/validate/types.js';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

function publicPath(name: string): string {
  return `${repoRoot}fixtures/wsdl/public/${name}/service.wsdl`;
}

function craftedPath(name: string): string {
  return `${repoRoot}fixtures/wsdl/crafted/${name}/service.wsdl`;
}

const codes = (problems: readonly ValidationProblem[]): string[] => problems.map((problem) => problem.code);

/** A SOAP 1.1 envelope whose body is `body`, indented so `body` starts on line 4. */
function envelope(body: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">',
    '   <soapenv:Header/>',
    '   <soapenv:Body>',
    body,
    '   </soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('\n');
}

const ADD_BODY = [
  '      <tem:Add>',
  '         <tem:intA>1</tem:intA>',
  '         <tem:intB>2</tem:intB>',
  '      </tem:Add>',
].join('\n');

describe('validateAgainstSchemaSet — Calculator (document/literal)', () => {
  let calculator: ImportResult;

  beforeAll(async () => {
    calculator = await importDefinition({ kind: 'file', path: publicPath('calculator') });
  });

  const validate = (xml: string) =>
    validateAgainstSchemaSet(xml, { schemaSet: calculator.schemaSet, bundle: calculator.bundle });

  it('accepts a valid request', async () => {
    await expect(validate(envelope(ADD_BODY))).resolves.toEqual([]);
  });

  it('flags a string in intA at the intA line', async () => {
    const problems = await validate(envelope(ADD_BODY.replace('1</tem:intA>', 'abc</tem:intA>')));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.severity).toBe('error');
    expect(problems[0]?.source).toBe('schema');
    expect(problems[0]?.message).toContain('intA');
    // `<tem:intA>` sits on line 6 of the envelope above.
    expect(problems[0]?.line).toBe(6);
  });

  it('flags a missing required intB, naming it', async () => {
    const problems = await validate(
      envelope(['      <tem:Add>', '         <tem:intA>1</tem:intA>', '      </tem:Add>'].join('\n')),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('intB');
  });

  it('flags an unknown element inside the body element', async () => {
    const problems = await validate(
      envelope(
        [
          '      <tem:Add>',
          '         <tem:intA>1</tem:intA>',
          '         <tem:intB>2</tem:intB>',
          '         <tem:intC>3</tem:intC>',
          '      </tem:Add>',
        ].join('\n'),
      ),
    );
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]?.message).toContain('intC');
  });

  it('flags a body element with no global declaration', async () => {
    const problems = await validate(envelope('      <tem:Nope/>'));
    expect(codes(problems)).toEqual(['schema-unknown-element']);
    expect(problems[0]?.line).toBe(5);
  });

  it('validates a response body', async () => {
    const bad = envelope('      <tem:AddResponse><tem:AddResult>x</tem:AddResult></tem:AddResponse>');
    const problems = await validate(bad);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('AddResult');
    await expect(
      validate(envelope('      <tem:AddResponse><tem:AddResult>3</tem:AddResult></tem:AddResponse>')),
    ).resolves.toEqual([]);
  });

  it('validates every body child and carries a path', async () => {
    const problems = await validate(
      envelope('      <tem:Add><tem:intA>x</tem:intA><tem:intB>1</tem:intB></tem:Add>\n      <tem:Nope/>'),
    );
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(problems[0]?.path).toBe('/Envelope/Body/tem:Add');
  });

  it('returns nothing for an envelope with an empty body', async () => {
    await expect(validate(envelope('   '))).resolves.toEqual([]);
  });

  it('returns nothing when the envelope cannot be tokenized', async () => {
    await expect(validate('<soapenv:Envelope>< not xml')).resolves.toEqual([]);
  });

  it('reuses the cached file set for the same bundle', async () => {
    const first = await validate(envelope(ADD_BODY));
    const second = await validate(envelope(ADD_BODY));
    expect(first).toEqual(second);
  });
});

describe('validateAgainstSchemaSet — performance', () => {
  it('validates a body padded past 500 KB with legal repeated elements in under two seconds', async () => {
    // A recursive `Node` type with an unbounded, self-typed `child` element — a large but
    // entirely legal document, unlike padding the body with a comment (which a real schema
    // validation pass never actually has to parse as content).
    const nodeWsdl = [
      '<?xml version="1.0"?>',
      '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"',
      '             xmlns:tns="urn:wb:perf" xmlns:xs="http://www.w3.org/2001/XMLSchema"',
      '             targetNamespace="urn:wb:perf" name="PerfService">',
      '  <types>',
      '    <xs:schema targetNamespace="urn:wb:perf" xmlns:tns="urn:wb:perf" elementFormDefault="qualified">',
      '      <xs:complexType name="Node">',
      '        <xs:sequence><xs:element name="child" type="tns:Node" minOccurs="0" maxOccurs="unbounded"/></xs:sequence>',
      '      </xs:complexType>',
      '      <xs:element name="NodeEl" type="tns:Node"/>',
      '    </xs:schema>',
      '  </types>',
      '  <message name="NodeIn"><part name="parameters" element="tns:NodeEl"/></message>',
      '  <message name="NodeOut"><part name="parameters" element="tns:NodeEl"/></message>',
      '  <portType name="PT"><operation name="Op"><input message="tns:NodeIn"/><output message="tns:NodeOut"/></operation></portType>',
      '  <binding name="B" type="tns:PT">',
      '    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>',
      '    <operation name="Op"><soap:operation soapAction="urn:wb:perf/Op"/>',
      '      <input><soap:body use="literal"/></input><output><soap:body use="literal"/></output>',
      '    </operation>',
      '  </binding>',
      '  <service name="S"><port name="P" binding="tns:B"><soap:address location="http://example.invalid/"/></port></service>',
      '</definitions>',
    ].join('\n');
    const perf = await importDefinition({ kind: 'text', text: nodeWsdl });
    const target = { schemaSet: perf.schemaSet, bundle: perf.bundle };
    const children = '<tns:child/>'.repeat(25_000);
    const xml = [
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="urn:wb:perf">',
      '   <soapenv:Body>',
      `      <tns:NodeEl>${children}</tns:NodeEl>`,
      '   </soapenv:Body>',
      '</soapenv:Envelope>',
    ].join('\n');

    const started = performance.now();
    const problems = await validateAgainstSchemaSet(xml, target);
    expect(problems).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('validateAgainstSchemaSet — degenerate inputs', () => {
  let calculator: ImportResult;

  beforeAll(async () => {
    calculator = await importDefinition({ kind: 'file', path: publicPath('calculator') });
  });

  it('skips a schema set with no components at all', async () => {
    const empty = { elements: new Map(), types: new Map() } as unknown as ImportResult['schemaSet'];
    await expect(
      validateAgainstSchemaSet(envelope(ADD_BODY), { schemaSet: empty, bundle: calculator.bundle }),
    ).resolves.toEqual([]);
  });

  it('reports a timeout rather than hanging', async () => {
    const problems = await validateAgainstSchemaSet(
      envelope(ADD_BODY),
      { schemaSet: calculator.schemaSet, bundle: calculator.bundle },
      { timeoutMs: 0 },
    );
    expect(codes(problems)).toEqual(['schema-timeout']);
    expect(problems[0]?.severity).toBe('warning');
    expect(problems[0]?.line).toBe(5);
  });

  it('ignores a body that is not inside an Envelope', async () => {
    await expect(
      validateAgainstSchemaSet('<Body><tem:Add xmlns:tem="http://tempuri.org/"/></Body>', {
        schemaSet: calculator.schemaSet,
        bundle: calculator.bundle,
      }),
    ).resolves.toEqual([]);
  });
});

describe('validateAgainstSchemaSet — rpc/literal', () => {
  let rpc: ImportResult;

  beforeAll(async () => {
    rpc = await importDefinition({ kind: 'file', path: craftedPath('rpc-literal') });
  });

  const binding = {
    soapVersion: '1.1' as const,
    operation: 'Multiply',
    style: 'rpc' as const,
    parts: [
      { name: 'a', type: { namespaceUri: 'http://www.w3.org/2001/XMLSchema', localName: 'int' } },
      { name: 'b', type: { namespaceUri: 'http://www.w3.org/2001/XMLSchema', localName: 'int' } },
      { name: 'opts', type: { namespaceUri: 'urn:wb:rpclit', localName: 'Options' } },
    ],
  };

  const rpcEnvelope = (inner: string) =>
    [
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:rpc="urn:wb:rpclit">',
      '   <soapenv:Body>',
      inner,
      '   </soapenv:Body>',
      '</soapenv:Envelope>',
    ].join('\n');

  it('accepts valid parts in any order', async () => {
    const problems = await validateAgainstSchemaSet(
      rpcEnvelope(
        [
          '      <rpc:Multiply>',
          '         <b>2</b>',
          '         <a>1</a>',
          '         <opts><rounding>up</rounding><scale>2</scale></opts>',
          '      </rpc:Multiply>',
        ].join('\n'),
      ),
      { schemaSet: rpc.schemaSet, bundle: rpc.bundle },
      { binding },
    );
    expect(problems).toEqual([]);
  });

  it('flags a part whose value does not match its type', async () => {
    const problems = await validateAgainstSchemaSet(
      rpcEnvelope(
        [
          '      <rpc:Multiply>',
          '         <a>nope</a>',
          '         <b>2</b>',
          '         <opts><rounding>up</rounding><scale>2</scale></opts>',
          '      </rpc:Multiply>',
        ].join('\n'),
      ),
      { schemaSet: rpc.schemaSet, bundle: rpc.bundle },
      { binding },
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]?.line).toBe(4);
  });

  it('accepts parts whose element or type cannot be resolved', async () => {
    const problems = await validateAgainstSchemaSet(
      rpcEnvelope(['      <rpc:Multiply>', '         <a>anything</a>', '      </rpc:Multiply>'].join('\n')),
      { schemaSet: rpc.schemaSet, bundle: rpc.bundle },
      {
        binding: {
          soapVersion: '1.1',
          operation: 'Multiply',
          style: 'rpc',
          parts: [{ name: 'a', type: { namespaceUri: 'urn:not:imported', localName: 'Mystery' } }],
        },
      },
    );
    expect(problems).toEqual([]);
  });

  it('resolves a part declared by element reference', async () => {
    const problems = await validateAgainstSchemaSet(
      rpcEnvelope(['      <rpc:Multiply>', '         <a>1</a>', '      </rpc:Multiply>'].join('\n')),
      { schemaSet: rpc.schemaSet, bundle: rpc.bundle },
      {
        binding: {
          soapVersion: '1.1',
          operation: 'Multiply',
          style: 'rpc',
          parts: [{ name: 'a', element: { namespaceUri: 'urn:wb:rpclit', localName: 'Nope' } }],
        },
      },
    );
    expect(problems.length).toBeGreaterThan(0);
  });

  it('flags a part that is missing', async () => {
    const problems = await validateAgainstSchemaSet(
      rpcEnvelope(['      <rpc:Multiply>', '         <a>1</a>', '      </rpc:Multiply>'].join('\n')),
      { schemaSet: rpc.schemaSet, bundle: rpc.bundle },
      { binding },
    );
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe('validateAgainstSchemaSet — chameleon include', () => {
  it('resolves a type pulled in through a chameleon include', async () => {
    const chameleon = await importDefinition({ kind: 'file', path: craftedPath('chameleon-include') });
    const target = { schemaSet: chameleon.schemaSet, bundle: chameleon.bundle };
    const ok =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><Ping xmlns="urn:wb:chameleon">PING</Ping></soapenv:Body></soapenv:Envelope>';
    await expect(validateAgainstSchemaSet(ok, target)).resolves.toEqual([]);

    const bad = ok.replace('>PING<', '>PONG<');
    const problems = await validateAgainstSchemaSet(bad, target);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('PONG');
  });
});

describe('validateAgainstSchemaSet — nested imports', () => {
  it('resolves element declarations across imported schema documents', async () => {
    const nested = await importDefinition({ kind: 'file', path: craftedPath('nested-imports') });
    const target = { schemaSet: nested.schemaSet, bundle: nested.bundle };
    const problems = await validateAgainstSchemaSet(
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><Unknown xmlns="urn:nope"/></soapenv:Body></soapenv:Envelope>',
      target,
    );
    expect(codes(problems)).toEqual(['schema-unknown-element']);
  });
});

describe('validateAgainstSchemaSet — diagnostics never leak synthetic file names', () => {
  const SYNTHETIC_NAME = /\b(ns-\d+\.xsd|doc-\d+\.xsd|embedded-\d+\.xsd|wrapper\.xsd|body\.xml)\b/;

  it('replaces synthetic file names in a schema-set compile failure with a real label', async () => {
    // `schema-constructs`'s `StringArray` type references `soapenc:Array` without importing
    // its namespace, so the whole set fails to compile — libxml2's message names the synthetic
    // glue file it was compiling at the time, which a user has no way to make sense of.
    const constructs = await importDefinition({ kind: 'file', path: craftedPath('schema-constructs') });
    const xml = [
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="urn:wb:sc">',
      '   <soapenv:Body>',
      '      <tns:Level3El attr1="x" attr2="y" attr3="z"><a>x</a><b>1</b><c>RED</c></tns:Level3El>',
      '   </soapenv:Body>',
      '</soapenv:Envelope>',
    ].join('\n');
    const problems = await validateAgainstSchemaSet(xml, {
      schemaSet: constructs.schemaSet,
      bundle: constructs.bundle,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe('schema-unavailable');
    expect(problems[0]?.message).not.toMatch(SYNTHETIC_NAME);
    expect(problems[0]?.message).toContain('the schema set');
  });
});

describe('validateAgainstSchemaSet — quote-aware synthesis', () => {
  it('does not duplicate an inherited namespace declaration when an attribute value contains a raw ">"', async () => {
    // A literal '>' needs no escaping inside an XML attribute value, but a naive
    // `indexOf('>')` scan for the end of the `<xs:schema ...>` start tag stops there anyway,
    // truncating the tag and hiding an attribute that comes after it — here, the `xmlns:extra`
    // declaration the schema already carries, which would otherwise be injected a second time
    // (a duplicate attribute, which libxml2 rejects as not well formed) because the ancestor
    // `definitions` element declares the same prefix.
    const quoteWsdl = [
      '<?xml version="1.0"?>',
      '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"',
      '             xmlns:tns="urn:wb:quote" xmlns:extra="urn:extra" xmlns:xs="http://www.w3.org/2001/XMLSchema"',
      '             targetNamespace="urn:wb:quote" name="QuoteAttrService">',
      '  <types>',
      '    <xs:schema version="1.0&gt;x" xmlns:extra="urn:extra" targetNamespace="urn:wb:quote" elementFormDefault="qualified">',
      '      <xs:element name="Ping" type="xs:string"/>',
      '    </xs:schema>',
      '  </types>',
      '  <message name="PingIn"><part name="parameters" element="tns:Ping"/></message>',
      '  <message name="PingOut"><part name="parameters" element="tns:Ping"/></message>',
      '  <portType name="PT"><operation name="Ping"><input message="tns:PingIn"/><output message="tns:PingOut"/></operation></portType>',
      '  <binding name="B" type="tns:PT">',
      '    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>',
      '    <operation name="Ping"><soap:operation soapAction="urn:wb:quote/Ping"/>',
      '      <input><soap:body use="literal"/></input><output><soap:body use="literal"/></output>',
      '    </operation>',
      '  </binding>',
      '  <service name="S"><port name="P" binding="tns:B"><soap:address location="http://example.invalid/"/></port></service>',
      '</definitions>',
    ].join('\n');
    const quote = await importDefinition({ kind: 'text', text: quoteWsdl });
    const target = { schemaSet: quote.schemaSet, bundle: quote.bundle };
    const xml =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><Ping xmlns="urn:wb:quote">hi</Ping></soapenv:Body></soapenv:Envelope>';
    await expect(validateAgainstSchemaSet(xml, target)).resolves.toEqual([]);
  });
});

describe('validateAgainstSchemaSet — timeout guard', () => {
  it('refuses a second validation for the same interface while a timed-out one is still outstanding', async () => {
    vi.resetModules();
    let resolveFirst: (value: { valid: boolean; errors: never[] }) => void = () => undefined;
    const fakeValidateXML = vi.fn().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    fakeValidateXML.mockResolvedValue({ valid: true, errors: [] });
    vi.doMock('xmllint-wasm', () => ({ validateXML: fakeValidateXML }));

    const { validateAgainstSchemaSet: validateWithFake } = await import('../../../src/validate/schema-validator.js');
    const { importDefinition: importWithFake } = await import('../../../src/import.js');
    const calculator = await importWithFake({ kind: 'file', path: publicPath('calculator') });
    const target = { schemaSet: calculator.schemaSet, bundle: calculator.bundle };

    const first = validateWithFake(envelope(ADD_BODY), target, { timeoutMs: 0 });
    const firstProblems = await first;
    expect(codes(firstProblems)).toEqual(['schema-timeout']);
    expect(fakeValidateXML).toHaveBeenCalledTimes(1);

    // The underlying libxml2 call from `first` never settled — a second validation for the
    // same bundle must not start a second one, and reports the same "still running" finding.
    const second = await validateWithFake(envelope(ADD_BODY), target, { timeoutMs: 0 });
    expect(codes(second)).toEqual(['schema-timeout']);
    expect(second[0]?.message).toContain('has not finished yet');
    expect(fakeValidateXML).toHaveBeenCalledTimes(1);

    // Once the stale call finally settles, a fresh validation is allowed to start again.
    resolveFirst({ valid: true, errors: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const third = await validateWithFake(envelope(ADD_BODY), target, { timeoutMs: 10_000 });
    expect(third).toEqual([]);
    expect(fakeValidateXML).toHaveBeenCalledTimes(2);

    vi.doUnmock('xmllint-wasm');
    vi.resetModules();
  });
});
