import { describe, expect, it } from 'vitest';
import { generateEmptyRequest, generateRequest } from '../../src/generate.js';
import { importDefinition } from '../../src/import.js';
import { summarizeOperations } from '../../src/operations.js';
import { parseWsdlDocument } from '../../src/wsdl/parse-wsdl.js';
import { parseXml } from '../../src/xml/parse.js';
import { readPublicFixture } from '../helpers/fixtures.js';

function parseFixture(name: string) {
  const text = readPublicFixture(name);
  const doc = parseXml(text, { location: `${name}/service.wsdl` });
  return parseWsdlDocument(doc, `${name}/service.wsdl`);
}

describe('summarizeOperations', () => {
  const def = parseFixture('calculator');
  const summaries = summarizeOperations(def);

  it('lists one summary per binding x operation', () => {
    // 2 bindings (CalculatorSoap, CalculatorSoap12) x 4 operations each
    expect(summaries).toHaveLength(8);
  });

  it('carries soap version, action, style and documentation from the binding/portType', () => {
    const add11 = summaries.find((s) => s.bindingName.localName === 'CalculatorSoap' && s.operationName === 'Add');
    expect(add11).toBeDefined();
    expect(add11?.soapVersion).toBe('1.1');
    expect(add11?.soapAction).toBe('http://tempuri.org/Add');
    expect(add11?.style).toBe('document');
    expect(add11?.documentation).toContain('Adds two integers');

    const add12 = summaries.find((s) => s.bindingName.localName === 'CalculatorSoap12' && s.operationName === 'Add');
    expect(add12?.soapVersion).toBe('1.2');
  });

  it('maps each binding to the ports (and services) that reference it', () => {
    const add11 = summaries.find((s) => s.bindingName.localName === 'CalculatorSoap' && s.operationName === 'Add');
    expect(add11?.ports).toEqual([
      {
        serviceName: { namespaceUri: def.targetNamespace, localName: 'Calculator' },
        portName: 'CalculatorSoap',
        address: 'http://www.dneonline.com/calculator.asmx',
      },
    ]);

    const add12 = summaries.find((s) => s.bindingName.localName === 'CalculatorSoap12' && s.operationName === 'Add');
    expect(add12?.ports).toEqual([
      {
        serviceName: { namespaceUri: def.targetNamespace, localName: 'Calculator' },
        portName: 'CalculatorSoap12',
        address: 'http://www.dneonline.com/calculator.asmx',
      },
    ]);
  });

  it('omits documentation when the abstract operation has none', () => {
    const subtract = summaries.find(
      (s) => s.bindingName.localName === 'CalculatorSoap' && s.operationName === 'Subtract',
    );
    expect(subtract?.documentation).toBeUndefined();
  });

  it('returns an empty ports array for a binding no service/port references', () => {
    const orphan = { ...def, bindings: def.bindings, services: [] };
    const orphanSummaries = summarizeOperations(orphan);
    expect(orphanSummaries.every((s) => s.ports.length === 0)).toBe(true);
  });
});

describe('importDefinition — invalid ImportSource', () => {
  it('throws a WsdlParseError with code invalid-url for a malformed URL source', async () => {
    await expect(importDefinition({ kind: 'url', url: 'not a url' })).rejects.toMatchObject({
      code: 'invalid-url',
    });
  });
});

describe('generateRequest / generateEmptyRequest — ImportResult convenience wrappers', () => {
  it('build the same envelopes as buildSampleRequest/buildEmptyRequest given an ImportResult', async () => {
    const result = await importDefinition({ kind: 'text', text: readPublicFixture('calculator') });
    const op = {
      bindingName: { namespaceUri: result.definition.targetNamespace, localName: 'CalculatorSoap' },
      operationName: 'Add',
    };

    const sample = generateRequest(result, op);
    expect(sample.envelopeXml).toContain('<tem:Add>');

    const empty = generateEmptyRequest(result, op);
    expect(empty.envelopeXml).not.toContain('<tem:Add>');
    expect(empty.soapVersion).toBe('1.1');
  });
});
