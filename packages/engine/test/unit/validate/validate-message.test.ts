import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { importDefinition } from '../../../src/import.js';
import type { ImportResult } from '../../../src/types.js';
import { bindingContextFor, validateMessage } from '../../../src/validate/index.js';
import type { ValidationBinding } from '../../../src/validate/index.js';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

const CALCULATOR_NS = 'http://tempuri.org/';

function envelope(body: string, version: '1.1' | '1.2' = '1.1'): string {
  const ns =
    version === '1.1' ? 'http://schemas.xmlsoap.org/soap/envelope/' : 'http://www.w3.org/2003/05/soap-envelope';
  return [
    `<soapenv:Envelope xmlns:soapenv="${ns}" xmlns:tem="${CALCULATOR_NS}">`,
    '   <soapenv:Header/>',
    '   <soapenv:Body>',
    body,
    '   </soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('\n');
}

const ADD = '      <tem:Add><tem:intA>1</tem:intA><tem:intB>2</tem:intB></tem:Add>';

describe('validateMessage', () => {
  let calculator: ImportResult;
  let binding: ValidationBinding;

  beforeAll(async () => {
    calculator = await importDefinition({
      kind: 'file',
      path: `${repoRoot}fixtures/wsdl/public/calculator/service.wsdl`,
    });
    const context = bindingContextFor(
      calculator.definition,
      { bindingName: { namespaceUri: CALCULATOR_NS, localName: 'CalculatorSoap' }, operationName: 'Add' },
      'request',
    );
    expect(context).toBeDefined();
    binding = context as ValidationBinding;
  });

  const run = (xml: string, overrides: Partial<ValidateInput> = {}) =>
    validateMessage({
      xml,
      direction: 'request',
      schemaSet: calculator.schemaSet,
      bundle: calculator.bundle,
      binding,
      ...overrides,
    });

  type ValidateInput = Parameters<typeof validateMessage>[0];

  it('reports nothing for a valid request and times the run', async () => {
    const result = await run(envelope(ADD));
    expect(result.problems).toEqual([]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('combines structure and schema findings', async () => {
    const result = await run(envelope('      <tem:Add><tem:intA>x</tem:intA><tem:intB>2</tem:intB></tem:Add>'));
    expect(result.problems.map((problem) => problem.source)).toEqual(['schema']);
  });

  it('flags a SOAP 1.2 envelope on a 1.1 binding', async () => {
    const result = await run(envelope(ADD, '1.2'));
    expect(result.problems.map((problem) => problem.code)).toContain('soap-version-mismatch');
  });

  it('skips schema validation when the message is not well formed', async () => {
    const result = await run('<soapenv:Envelope><oops></soapenv:Envelope>');
    expect(result.problems.map((problem) => problem.code)).toEqual(['xml-not-well-formed']);
  });

  it('cross-checks the transport metadata', async () => {
    const result = await run(envelope(ADD), { http: { contentType: 'application/soap+xml' } });
    expect(result.problems.map((problem) => problem.code)).toEqual(['content-type-mismatch']);
  });

  it('honours an explicit timeout', async () => {
    const result = await run(envelope(ADD), { timeoutMs: 10_000 });
    expect(result.problems).toEqual([]);
  });
});

describe('bindingContextFor', () => {
  let calculator: ImportResult;

  beforeAll(async () => {
    calculator = await importDefinition({
      kind: 'file',
      path: `${repoRoot}fixtures/wsdl/public/calculator/service.wsdl`,
    });
  });

  const ref = (localName: string, operationName: string) => ({
    bindingName: { namespaceUri: CALCULATOR_NS, localName },
    operationName,
  });

  it('reads the SOAP version, style and input parts', () => {
    const context = bindingContextFor(calculator.definition, ref('CalculatorSoap', 'Add'), 'request');
    expect(context).toEqual({
      soapVersion: '1.1',
      operation: 'Add',
      style: 'document',
      parts: [{ name: 'parameters', element: { namespaceUri: CALCULATOR_NS, localName: 'Add' } }],
    });
  });

  it('reads the output parts for a response', () => {
    const context = bindingContextFor(calculator.definition, ref('CalculatorSoap', 'Add'), 'response');
    expect(context?.parts[0]?.element?.localName).toBe('AddResponse');
  });

  it('reads the 1.2 binding', () => {
    expect(bindingContextFor(calculator.definition, ref('CalculatorSoap12', 'Add'), 'request')?.soapVersion).toBe(
      '1.2',
    );
  });

  it('returns undefined for an unknown binding or operation', () => {
    expect(bindingContextFor(calculator.definition, ref('Nope', 'Add'), 'request')).toBeUndefined();
    expect(bindingContextFor(calculator.definition, ref('CalculatorSoap', 'Nope'), 'request')).toBeUndefined();
  });

  it('carries rpc parts with their types', async () => {
    const rpc = await importDefinition({
      kind: 'file',
      path: `${repoRoot}fixtures/wsdl/crafted/rpc-literal/service.wsdl`,
    });
    const context = bindingContextFor(
      rpc.definition,
      { bindingName: { namespaceUri: 'urn:wb:rpclit', localName: 'RpcLiteralBinding' }, operationName: 'Multiply' },
      'request',
    );
    expect(context?.style).toBe('rpc');
    expect(context?.parts.map((part) => part.name)).toEqual(['a', 'b', 'opts']);
    expect(context?.parts[2]?.type).toEqual({ namespaceUri: 'urn:wb:rpclit', localName: 'Options' });
  });
});
