import { describe, expect, it } from 'vitest';
import { quickOpenEntries } from '../../src/renderer/shell/quick-open.js';
import type { InterfaceSummary, RequestWire } from '../../src/shared/wire-types.js';

const BINDING = '{http://tempuri.org/}CalculatorSoap';

function summary(): InterfaceSummary {
  return {
    id: 'if-1',
    name: 'Calculator',
    definitionUrl: 'http://example.test/calc.wsdl',
    targetNamespace: 'http://tempuri.org/',
    soapVersions: ['1.1'],
    services: [],
    operations: [
      {
        name: 'Add',
        binding: BINDING,
        bindingLocal: 'CalculatorSoap',
        soapVersion: '1.1',
        style: 'document',
        ports: [],
        inputMimeParts: [],
      },
      {
        name: 'Subtract',
        binding: BINDING,
        bindingLocal: 'CalculatorSoap',
        soapVersion: '1.1',
        style: 'document',
        ports: [],
        inputMimeParts: [],
      },
    ],
    problems: [],
    documentCount: 1,
  };
}

function request(): RequestWire {
  return {
    id: 'req-1',
    interfaceId: 'if-1',
    bindingName: BINDING,
    operationName: 'Add',
    name: 'Request 1',
    envelopeXml: '<x/>',
    soapVersion: '1.1',
    headers: [],
    order: 0,
    attachments: [],
    properties: {},
  } as unknown as RequestWire;
}

describe('quickOpenEntries', () => {
  it('lists saved requests first, with an interface › binding › operation breadcrumb', () => {
    const entries = quickOpenEntries({ 'if-1': summary() }, { 'req-1': request() });

    expect(entries[0]?.kind).toBe('request');
    expect(entries[0]?.label).toBe('Request 1');
    expect(entries[0]?.detail).toBe('Calculator › CalculatorSoap › Add');
  });

  it('lists only the operations that have no request yet', () => {
    const entries = quickOpenEntries({ 'if-1': summary() }, { 'req-1': request() });

    expect(entries.filter((entry) => entry.kind === 'operation').map((entry) => entry.label)).toEqual(['Subtract']);
  });

  it('lists every operation when the project has no requests', () => {
    const entries = quickOpenEntries({ 'if-1': summary() }, {});

    expect(entries.map((entry) => entry.label)).toEqual(['Add', 'Subtract']);
  });

  it('carries what creating a request from an operation needs', () => {
    const operation = quickOpenEntries({ 'if-1': summary() }, {})[0];

    expect(operation).toMatchObject({ interfaceId: 'if-1', bindingName: BINDING, operationName: 'Add' });
  });

  it('matches on the breadcrumb as well as the name', () => {
    expect(quickOpenEntries({ 'if-1': summary() }, {})[0]?.value).toContain('Calculator');
  });

  it('gives every entry a unique key', () => {
    const entries = quickOpenEntries({ 'if-1': summary() }, { 'req-1': request() });

    expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length);
  });

  it('is empty for an empty project', () => {
    expect(quickOpenEntries({}, {})).toEqual([]);
  });
});
