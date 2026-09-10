import { describe, expect, it } from 'vitest';
import type { InterfaceSummary } from '../../src/shared/wire-types.js';
import type { RequestDraft } from '../../src/renderer/state/project.js';
import { buildExplorerTree } from '../../src/renderer/features/explorer/tree-nodes.js';
import { REQUEST_PROPERTIES } from '../helpers/wire-defaults.js';

function iface(overrides: Partial<InterfaceSummary> = {}): InterfaceSummary {
  return {
    id: 'iface-1',
    name: 'Calculator',
    definitionUrl: 'http://example.test/service.wsdl',
    targetNamespace: 'http://tempuri.org/',
    soapVersions: ['1.1'],
    services: [
      {
        name: 'Calculator',
        ports: [
          {
            name: 'CalculatorSoap',
            address: 'http://example.test/soap',
            binding: '{tns}CalculatorSoap',
            soapVersion: '1.1',
          },
        ],
      },
    ],
    operations: [
      {
        name: 'Add',
        binding: '{tns}CalculatorSoap',
        bindingLocal: 'CalculatorSoap',
        soapVersion: '1.1',
        style: 'document',
        ports: [{ service: 'Calculator', port: 'CalculatorSoap', address: 'http://example.test/soap' }],
      },
    ],
    problems: [],
    documentCount: 1,
    ...overrides,
  };
}

function request(overrides: Partial<RequestDraft> = {}): RequestDraft {
  return {
    properties: REQUEST_PROPERTIES,
    id: 'req-1',
    interfaceId: 'iface-1',
    bindingName: '{tns}CalculatorSoap',
    operationName: 'Add',
    name: 'Request 1',
    envelopeXml: '<Envelope/>',
    soapVersion: '1.1',
    headers: [],
    order: 0,
    ...overrides,
  };
}

describe('buildExplorerTree', () => {
  it('builds interface -> endpoints/operations -> requests for a single binding', () => {
    const tree = buildExplorerTree([iface()], [request()]);

    expect(tree).toHaveLength(1);
    const [interfaceNode] = tree;
    expect(interfaceNode?.id).toBe('iface:iface-1');
    expect(interfaceNode?.kind).toBe('interface');
    expect(interfaceNode?.children).toHaveLength(2);

    const [endpoints, operations] = interfaceNode?.children ?? [];
    expect(endpoints?.kind).toBe('endpoints');
    expect(endpoints?.children).toHaveLength(1);
    expect(endpoints?.children?.[0]?.label).toBe('CalculatorSoap — http://example.test/soap');

    // Single binding: the binding-group level collapses, operations sit directly under Operations.
    expect(operations?.kind).toBe('operations');
    expect(operations?.children).toHaveLength(1);
    const [operationNode] = operations?.children ?? [];
    expect(operationNode?.kind).toBe('operation');
    expect(operationNode?.label).toBe('Add');
    expect(operationNode?.children).toHaveLength(1);
    expect(operationNode?.children?.[0]?.id).toBe('req:req-1');
    expect(operationNode?.children?.[0]?.kind).toBe('request');
  });

  it('groups operations by binding when an interface has multiple bindings', () => {
    const summary = iface({
      operations: [
        {
          name: 'Add',
          binding: '{tns}CalculatorSoap',
          bindingLocal: 'CalculatorSoap',
          soapVersion: '1.1',
          style: 'document',
          ports: [],
        },
        {
          name: 'Add',
          binding: '{tns}CalculatorSoap12',
          bindingLocal: 'CalculatorSoap12',
          soapVersion: '1.2',
          style: 'document',
          ports: [],
        },
      ],
    });
    const tree = buildExplorerTree([summary], []);
    const operations = tree[0]?.children?.[1];

    expect(operations?.children).toHaveLength(2);
    expect(operations?.children?.map((n) => n.kind)).toEqual(['binding', 'binding']);
    expect(operations?.children?.map((n) => n.label)).toEqual(['CalculatorSoap', 'CalculatorSoap12']);
  });

  it('sorts operations alphabetically and keeps requests in creation order', () => {
    const summary = iface({
      operations: [
        { name: 'Subtract', binding: '{tns}B', bindingLocal: 'B', soapVersion: '1.1', style: 'document', ports: [] },
        { name: 'Add', binding: '{tns}B', bindingLocal: 'B', soapVersion: '1.1', style: 'document', ports: [] },
      ],
    });
    const requests = [
      request({ id: 'req-2', bindingName: '{tns}B', operationName: 'Add', name: 'Request 2' }),
      request({ id: 'req-1', bindingName: '{tns}B', operationName: 'Add', name: 'Request 1' }),
    ];
    const tree = buildExplorerTree([summary], requests);
    const operations = tree[0]?.children?.[1];

    expect(operations?.children?.map((n) => n.label)).toEqual(['Add', 'Subtract']);
    const addNode = operations?.children?.find((n) => n.label === 'Add');
    expect(addNode?.children?.map((n) => n.id)).toEqual(['req:req-2', 'req:req-1']);
  });

  it('stable ids and a problem-count badge on the interface node', () => {
    const summary = iface({ problems: [{ source: 'wsdl', code: 'x', message: 'bad thing' }] });
    const tree = buildExplorerTree([summary], []);

    expect(tree[0]?.id).toBe('iface:iface-1');
    expect(tree[0]?.problemCount).toBe(1);

    const again = buildExplorerTree([summary], []);
    expect(again[0]?.id).toBe(tree[0]?.id);
  });
});
