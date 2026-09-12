import { describe, expect, it } from 'vitest';
import type { InterfaceSummary } from '../../src/shared/wire-types.js';
import type { RequestDraft } from '../../src/renderer/state/project.js';
import type { ExplorerNode } from '../../src/renderer/features/explorer/tree-nodes.js';
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
        inputMimeParts: [],
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
    attachments: [],
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

/** One ready internal project wrapping `summaries`; returns the interface nodes under it. */
function interfacesOf(summaries: readonly InterfaceSummary[], requests: readonly RequestDraft[]): ExplorerNode[] {
  const tree = buildExplorerTree(
    [{ id: 'p1', name: 'Demo', source: 'internal', dir: '/ws/projects/demo', status: 'ready' }],
    [{ projectId: 'p1', interfaceIds: summaries.map((summary) => summary.id) }],
    Object.fromEntries(summaries.map((summary) => [summary.id, summary])),
    requests,
  );
  return tree[0]?.children ?? [];
}

describe('buildExplorerTree', () => {
  it('builds interface -> endpoints/operations -> requests for a single binding', () => {
    const tree = interfacesOf([iface()], [request()]);

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
          inputMimeParts: [],
        },
        {
          name: 'Add',
          binding: '{tns}CalculatorSoap12',
          bindingLocal: 'CalculatorSoap12',
          soapVersion: '1.2',
          style: 'document',
          ports: [],
          inputMimeParts: [],
        },
      ],
    });
    const tree = interfacesOf([summary], []);
    const operations = tree[0]?.children?.[1];

    expect(operations?.children).toHaveLength(2);
    expect(operations?.children?.map((n) => n.kind)).toEqual(['binding', 'binding']);
    expect(operations?.children?.map((n) => n.label)).toEqual(['CalculatorSoap', 'CalculatorSoap12']);
  });

  it('sorts operations alphabetically and keeps requests in creation order', () => {
    const summary = iface({
      operations: [
        {
          name: 'Subtract',
          binding: '{tns}B',
          bindingLocal: 'B',
          soapVersion: '1.1',
          style: 'document',
          ports: [],
          inputMimeParts: [],
        },
        {
          name: 'Add',
          binding: '{tns}B',
          bindingLocal: 'B',
          soapVersion: '1.1',
          style: 'document',
          ports: [],
          inputMimeParts: [],
        },
      ],
    });
    const requests = [
      request({ id: 'req-2', bindingName: '{tns}B', operationName: 'Add', name: 'Request 2' }),
      request({ id: 'req-1', bindingName: '{tns}B', operationName: 'Add', name: 'Request 1' }),
    ];
    const tree = interfacesOf([summary], requests);
    const operations = tree[0]?.children?.[1];

    expect(operations?.children?.map((n) => n.label)).toEqual(['Add', 'Subtract']);
    const addNode = operations?.children?.find((n) => n.label === 'Add');
    expect(addNode?.children?.map((n) => n.id)).toEqual(['req:req-2', 'req:req-1']);
  });

  it('emits one root per workspace project, in workspace order, with its own interfaces', () => {
    const calculator = iface();
    const billing = iface({ id: 'iface-2', name: 'Billing' });
    const tree = buildExplorerTree(
      [
        { id: 'p2', name: 'Billing', source: 'linked', dir: '/elsewhere/billing', status: 'ready' },
        { id: 'p1', name: 'Calculator', source: 'internal', dir: '/ws/projects/calculator', status: 'loading' },
      ],
      [
        { projectId: 'p1', interfaceIds: [calculator.id] },
        { projectId: 'p2', interfaceIds: [billing.id] },
      ],
      { [calculator.id]: calculator, [billing.id]: billing },
      [],
    );

    // Workspace order wins over the project store's own (name-sorted) order.
    expect(tree.map((node) => node.id)).toEqual(['proj:p2', 'proj:p1']);
    expect(tree.map((node) => node.kind)).toEqual(['project', 'project']);
    expect(tree.map((node) => node.projectId)).toEqual(['p2', 'p1']);

    const [linked, loading] = tree;
    expect(linked?.linked).toBe(true);
    expect(linked?.dir).toBe('/elsewhere/billing');
    expect(linked?.loading).toBeUndefined();
    expect(linked?.children?.map((node) => node.id)).toEqual(['iface:iface-2']);

    // Only the root is prefixed: entity ids below it are ULIDs, already unique workspace-wide.
    expect(loading?.linked).toBeUndefined();
    expect(loading?.loading).toBe(true);
    expect(loading?.children?.map((node) => node.id)).toEqual(['iface:iface-1']);
    expect(loading?.children?.[0]?.children?.map((node) => node.id)).toEqual([
      'endpoints:iface-1',
      'operations:iface-1',
    ]);
  });

  it('gives a missing or unreadable project a single Locate…/Remove row instead of children', () => {
    const summary = iface();
    const tree = buildExplorerTree(
      [
        { id: 'p1', name: 'Gone', source: 'linked', dir: '/gone', status: 'missing' },
        { id: 'p2', name: 'Broken', source: 'internal', dir: '/ws/projects/broken', status: 'error', message: 'boom' },
      ],
      [{ projectId: 'p1', interfaceIds: [summary.id] }],
      { [summary.id]: summary },
      [],
    );

    const [missing, broken] = tree;
    // Its interfaces are not rendered: the folder the app would read them from is not there.
    expect(missing?.children).toHaveLength(1);
    expect(missing?.children?.[0]).toMatchObject({
      id: 'projmissing:p1',
      kind: 'project-missing',
      label: 'This project folder is missing.',
      projectId: 'p1',
    });
    expect(broken?.children?.[0]?.label).toBe('boom');
    expect(broken?.children?.[0]?.message).toBe('boom');
  });

  it('stable ids and a problem-count badge on the interface node', () => {
    const summary = iface({ problems: [{ source: 'wsdl', code: 'x', message: 'bad thing' }] });
    const tree = interfacesOf([summary], []);

    expect(tree[0]?.id).toBe('iface:iface-1');
    expect(tree[0]?.problemCount).toBe(1);

    const again = interfacesOf([summary], []);
    expect(again[0]?.id).toBe(tree[0]?.id);
  });
});
