import { REQUEST_PROPERTIES } from './helpers/wire-defaults.js';
import { describe, expect, it } from 'vitest';
import { createInterface, createProject, createRequest } from '@wirebench/engine';
import type { Interface, Project } from '@wirebench/engine';
import type { InterfaceSummary } from '../src/shared/wire-types.js';
import {
  clarkLocalName,
  findRequest,
  toInterfaceWire,
  toProjectWire,
  toRequestWires,
} from '../src/main/project-wire.js';

const BINDING = '{http://tempuri.org/}CalculatorSoap';

function buildProject(): Project {
  const request = createRequest('Request 1', {
    id: 'req-1',
    envelopeXml: '<Envelope><intA>1</intA></Envelope>',
    soapVersion: '1.1',
    soapAction: 'http://tempuri.org/Add',
    endpointId: 'ep-1',
    headers: [{ name: 'X-Trace', value: 'on' }],
  });
  const iface: Interface = createInterface('Calculator', {
    id: 'iface-1',
    definitionUrl: 'http://example.test/service.wsdl',
    targetNamespace: 'http://tempuri.org/',
    endpoints: [{ id: 'ep-1', name: 'Calculator Soap', url: 'http://example.test/soap', authMode: 'complement' }],
    operations: [{ name: 'Add', bindingName: BINDING, slug: 'Add', order: 0, requests: [request] }],
  });
  return { ...createProject('Demo', { id: 'proj-1' }), interfaces: [iface] };
}

const summary: InterfaceSummary = {
  wsa: { enabled: false, version: '2005/08', defaultActionByOperation: {} },
  id: 'iface-1',
  name: 'Calculator',
  definitionUrl: 'http://example.test/service.wsdl',
  targetNamespace: 'http://tempuri.org/',
  soapVersions: ['1.1'],
  services: [{ name: 'Calculator', ports: [{ name: 'CalculatorSoap', binding: BINDING, soapVersion: '1.1' }] }],
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
  documentCount: 2,
};

describe('project-wire', () => {
  it('clarkLocalName strips the namespace, and passes a bare name through', () => {
    expect(clarkLocalName(BINDING)).toBe('CalculatorSoap');
    expect(clarkLocalName('CalculatorSoap')).toBe('CalculatorSoap');
  });

  it('projects a saved project into the renderer mirror', () => {
    const wire = toProjectWire(buildProject(), {
      dir: '/tmp/demo',
      dirty: true,
      lastSavedAt: '2026-09-10T08:00:00.000Z',
      problems: [{ code: 'missing-envelope', message: 'gone', file: 'a.xml' }],
      runtime: new Map([['iface-1', { hydration: 'ready', summary }]]),
    });

    expect(wire).toMatchObject({ id: 'proj-1', name: 'Demo', dir: '/tmp/demo', dirty: true });
    expect(wire.lastSavedAt).toBe('2026-09-10T08:00:00.000Z');
    expect(wire.problems).toHaveLength(1);

    const [iface] = wire.interfaces;
    expect(iface?.slug).toBe('Calculator');
    expect(iface?.hydration).toBe('ready');
    expect(iface?.endpoints).toEqual([
      { id: 'ep-1', name: 'Calculator Soap', url: 'http://example.test/soap', authMode: 'complement' },
    ]);
    expect(iface?.defaultEndpointId).toBe('ep-1');
    // Both the hydrated operations survive, deduped against the one the model declares.
    expect(iface?.operations.map((op) => op.name)).toEqual(['Add', 'Subtract']);

    expect(wire.requests).toEqual([
      {
        id: 'req-1',
        interfaceId: 'iface-1',
        bindingName: BINDING,
        operationName: 'Add',
        name: 'Request 1',
        envelopeXml: '<Envelope><intA>1</intA></Envelope>',
        soapVersion: '1.1',
        soapAction: 'http://tempuri.org/Add',
        endpointId: 'ep-1',
        headers: [{ name: 'X-Trace', value: 'on' }],
        order: 0,
        attachments: [],
        properties: REQUEST_PROPERTIES,
      },
    ]);
  });

  it('renders an un-hydrated interface from the model alone', () => {
    const project = buildProject();
    const iface = project.interfaces[0]!;
    const wire = toInterfaceWire(iface, undefined);

    expect(wire.hydration).toBe('pending');
    expect(wire.services).toEqual([]);
    expect(wire.documentCount).toBe(0);
    // The tree still has something to render before the definition cache is read back.
    expect(wire.operations).toEqual([
      {
        name: 'Add',
        binding: BINDING,
        bindingLocal: 'CalculatorSoap',
        soapVersion: '1.1',
        style: 'document',
        ports: [],
        inputMimeParts: [],
      },
    ]);
  });

  it('finds a request by id, and reports an unknown one as undefined', () => {
    const project = buildProject();
    expect(findRequest(project, 'req-1')?.operation.name).toBe('Add');
    expect(findRequest(project, 'nope')).toBeUndefined();
    expect(toRequestWires(project)).toHaveLength(1);
  });
});

describe('toRequestWires attachments', () => {
  it('projects both attachment source kinds field for field', () => {
    const project = buildProject();
    const request = project.interfaces[0]!.operations[0]!.requests[0]!;
    const withAttachments: Project = {
      ...project,
      interfaces: [
        {
          ...project.interfaces[0]!,
          operations: [
            {
              ...project.interfaces[0]!.operations[0]!,
              requests: [
                {
                  ...request,
                  attachments: [
                    {
                      id: 'att-1',
                      name: 'logo.png',
                      contentType: 'image/png',
                      size: 12,
                      part: 'file',
                      type: 'MIME',
                      contentId: 'att-1@wirebench',
                      cached: true,
                      source: { kind: 'cache', sha256: 'b'.repeat(64) },
                    },
                    {
                      id: 'att-2',
                      name: 'notes.txt',
                      contentType: 'text/plain',
                      size: 4,
                      type: 'UNKNOWN',
                      contentId: 'att-2@wirebench',
                      cached: false,
                      source: { kind: 'path', path: '/files/notes.txt' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const [wire] = toRequestWires(withAttachments);

    expect(wire?.attachments).toEqual([
      {
        id: 'att-1',
        name: 'logo.png',
        contentType: 'image/png',
        size: 12,
        part: 'file',
        type: 'MIME',
        contentId: 'att-1@wirebench',
        cached: true,
        source: { kind: 'cache', sha256: 'b'.repeat(64) },
      },
      {
        id: 'att-2',
        name: 'notes.txt',
        contentType: 'text/plain',
        size: 4,
        type: 'UNKNOWN',
        contentId: 'att-2@wirebench',
        cached: false,
        source: { kind: 'path', path: '/files/notes.txt' },
      },
    ]);
    // No `part` key at all rather than an explicit undefined, so the wire stays JSON-clean.
    expect(Object.hasOwn(wire!.attachments[1]!, 'part')).toBe(false);
  });
});
