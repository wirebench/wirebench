import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InterfaceSummary, RequestGenerateResponse } from '../../src/shared/wire-types.js';
import { useProjectStore } from '../../src/renderer/state/project.js';

const summary: InterfaceSummary = {
  id: 'iface-1',
  name: 'Calculator',
  definitionUrl: 'http://example.test/service.wsdl',
  targetNamespace: 'http://tempuri.org/',
  soapVersions: ['1.1'],
  services: [{ name: 'Calculator', ports: [{ name: 'CalculatorSoap', binding: '{tns}B', soapVersion: '1.1' }] }],
  operations: [
    {
      name: 'Add',
      binding: '{tns}B',
      bindingLocal: 'B',
      soapVersion: '1.1',
      style: 'document',
      ports: [{ service: 'Calculator', port: 'CalculatorSoap', address: 'http://example.test/soap' }],
    },
    {
      name: 'Subtract',
      binding: '{tns}B',
      bindingLocal: 'B',
      soapVersion: '1.1',
      style: 'document',
      ports: [{ service: 'Calculator', port: 'CalculatorSoap', address: 'http://example.test/soap' }],
    },
  ],
  problems: [],
  documentCount: 1,
};

function generated(name: string): RequestGenerateResponse {
  return {
    envelopeXml: `<Envelope>${name}</Envelope>`,
    soapVersion: '1.1',
    contentType: 'text/xml',
    headers: { SOAPAction: `"${name}"` },
    problems: [],
  };
}

describe('useProjectStore', () => {
  beforeEach(() => {
    useProjectStore.setState({ interfaces: {}, requests: {}, order: [] });
  });

  it('importDefinition adds the interface and one request draft per operation', async () => {
    const importFn = vi.fn().mockResolvedValue({ ok: true, value: summary });
    const generateFn = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: generated('Add') })
      .mockResolvedValueOnce({ ok: true, value: generated('Subtract') });
    window.wirebench = {
      definition: { import: importFn, close: vi.fn(), cancelImport: vi.fn() },
      request: { generate: generateFn, send: vi.fn(), cancel: vi.fn() },
      app: { version: vi.fn() },
      dialogs: { openFile: vi.fn(), openFolder: vi.fn() },
      files: { pathFor: vi.fn() },
      on: vi.fn(),
    };

    const result = await useProjectStore.getState().importDefinition({ kind: 'url', url: summary.definitionUrl });

    expect(result).toEqual(summary);
    expect(importFn).toHaveBeenCalledWith({ source: { kind: 'url', url: summary.definitionUrl } });
    const state = useProjectStore.getState();
    expect(state.interfaces['iface-1']).toEqual(summary);
    expect(state.order).toEqual(['iface-1']);
    const drafts = Object.values(state.requests);
    expect(drafts).toHaveLength(2);
    expect(drafts.map((d) => d.operationName).sort()).toEqual(['Add', 'Subtract']);
    for (const draft of drafts) {
      expect(draft.interfaceId).toBe('iface-1');
      expect(draft.endpoint).toBe('http://example.test/soap');
      expect(draft.envelopeXml).toContain(draft.operationName);
    }
  });

  it('a failed generate produces a draft with an empty envelope and a problem', async () => {
    window.wirebench = {
      definition: {
        import: vi.fn().mockResolvedValue({ ok: true, value: { ...summary, operations: [summary.operations[0]] } }),
        close: vi.fn(),
        cancelImport: vi.fn(),
      },
      request: {
        generate: vi.fn().mockResolvedValue({ ok: false, error: { code: 'boom', message: 'generation failed' } }),
        send: vi.fn(),
        cancel: vi.fn(),
      },
      app: { version: vi.fn() },
      dialogs: { openFile: vi.fn(), openFolder: vi.fn() },
      files: { pathFor: vi.fn() },
      on: vi.fn(),
    };

    await useProjectStore.getState().importDefinition({ kind: 'url', url: summary.definitionUrl });

    const drafts = Object.values(useProjectStore.getState().requests);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.envelopeXml).toBe('');
    expect(drafts[0]?.problems?.[0]?.message).toBe('generation failed');
  });

  it('removeInterface calls definition.close and drops the interface plus its drafts', async () => {
    const closeFn = vi.fn().mockResolvedValue({ ok: true, value: { closed: true } });
    useProjectStore.setState({
      interfaces: { 'iface-1': summary },
      requests: {
        r1: {
          id: 'r1',
          interfaceId: 'iface-1',
          bindingName: '{tns}B',
          operationName: 'Add',
          name: 'Request 1',
          envelopeXml: '',
          soapVersion: '1.1',
          headers: {},
        },
      },
      order: ['iface-1'],
    });
    window.wirebench = {
      definition: { import: vi.fn(), close: closeFn, cancelImport: vi.fn() },
      request: { generate: vi.fn(), send: vi.fn(), cancel: vi.fn() },
      app: { version: vi.fn() },
      dialogs: { openFile: vi.fn(), openFolder: vi.fn() },
      files: { pathFor: vi.fn() },
      on: vi.fn(),
    };

    await useProjectStore.getState().removeInterface('iface-1');

    expect(closeFn).toHaveBeenCalledWith({ interfaceId: 'iface-1' });
    const state = useProjectStore.getState();
    expect(state.interfaces['iface-1']).toBeUndefined();
    expect(state.order).toEqual([]);
    expect(state.requests['r1']).toBeUndefined();
  });

  it('updateRequest and setEndpoint patch an existing draft', () => {
    useProjectStore.setState({
      interfaces: {},
      requests: {
        r1: {
          id: 'r1',
          interfaceId: 'iface-1',
          bindingName: '{tns}B',
          operationName: 'Add',
          name: 'Request 1',
          envelopeXml: 'x',
          soapVersion: '1.1',
          headers: {},
        },
      },
      order: [],
    });

    useProjectStore.getState().updateRequest('r1', { name: 'Renamed' });
    expect(useProjectStore.getState().requests['r1']?.name).toBe('Renamed');

    useProjectStore.getState().setEndpoint('r1', 'http://new-endpoint.test');
    expect(useProjectStore.getState().requests['r1']?.endpoint).toBe('http://new-endpoint.test');
  });

  it('addRequest generates another draft named by existing-draft count for the operation', async () => {
    const generateFn = vi.fn().mockResolvedValue({ ok: true, value: generated('Add') });
    useProjectStore.setState({
      interfaces: { 'iface-1': summary },
      requests: {
        r1: {
          id: 'r1',
          interfaceId: 'iface-1',
          bindingName: '{tns}B',
          operationName: 'Add',
          name: 'Request 1',
          envelopeXml: 'x',
          soapVersion: '1.1',
          headers: {},
        },
      },
      order: ['iface-1'],
    });
    window.wirebench = {
      definition: { import: vi.fn(), close: vi.fn(), cancelImport: vi.fn() },
      request: { generate: generateFn, send: vi.fn(), cancel: vi.fn() },
      app: { version: vi.fn() },
      dialogs: { openFile: vi.fn(), openFolder: vi.fn() },
      files: { pathFor: vi.fn() },
      on: vi.fn(),
    };

    const newId = await useProjectStore.getState().addRequest('iface-1', '{tns}B', 'Add');

    expect(generateFn).toHaveBeenCalledWith({ interfaceId: 'iface-1', bindingName: '{tns}B', operationName: 'Add' });
    const draft = useProjectStore.getState().requests[newId];
    expect(draft?.name).toBe('Request 2');
    expect(draft?.interfaceId).toBe('iface-1');
    expect(draft?.operationName).toBe('Add');
    expect(Object.keys(useProjectStore.getState().requests)).toHaveLength(2);
  });

  it('cloneRequest copies a draft with a "(copy)" name and a new id', () => {
    useProjectStore.setState({
      interfaces: {},
      requests: {
        r1: {
          id: 'r1',
          interfaceId: 'iface-1',
          bindingName: '{tns}B',
          operationName: 'Add',
          name: 'Request 1',
          envelopeXml: 'x',
          soapVersion: '1.1',
          headers: { a: 'b' },
        },
      },
      order: [],
    });

    const newId = useProjectStore.getState().cloneRequest('r1');

    expect(newId).not.toBe('r1');
    const clone = useProjectStore.getState().requests[newId];
    expect(clone?.name).toBe('Request 1 (copy)');
    expect(clone?.envelopeXml).toBe('x');
    expect(clone?.headers).toEqual({ a: 'b' });
    expect(useProjectStore.getState().requests['r1']?.name).toBe('Request 1');
  });

  it('removeRequest deletes the draft and closes its open editor tab', async () => {
    const { useEditorsStore } = await import('../../src/renderer/state/editors.js');
    useProjectStore.setState({
      interfaces: {},
      requests: {
        r1: {
          id: 'r1',
          interfaceId: 'iface-1',
          bindingName: '{tns}B',
          operationName: 'Add',
          name: 'Request 1',
          envelopeXml: 'x',
          soapVersion: '1.1',
          headers: {},
        },
      },
      order: [],
    });
    useEditorsStore.setState({
      tabs: [{ id: 'request:r1', kind: 'request', title: 'Request 1', requestId: 'r1' }],
      activeId: 'request:r1',
    });

    useProjectStore.getState().removeRequest('r1');

    expect(useProjectStore.getState().requests['r1']).toBeUndefined();
    expect(useEditorsStore.getState().tabs).toHaveLength(0);
  });

  it('delete-then-add yields Request 3 when Request 1 and 2 exist then 1 is deleted', async () => {
    const generateFn = vi.fn().mockResolvedValue({ ok: true, value: generated('Add') });
    useProjectStore.setState({
      interfaces: { 'iface-1': summary },
      requests: {
        r1: {
          id: 'r1',
          interfaceId: 'iface-1',
          bindingName: '{tns}B',
          operationName: 'Add',
          name: 'Request 1',
          envelopeXml: 'x',
          soapVersion: '1.1',
          headers: {},
        },
        r2: {
          id: 'r2',
          interfaceId: 'iface-1',
          bindingName: '{tns}B',
          operationName: 'Add',
          name: 'Request 2',
          envelopeXml: 'x',
          soapVersion: '1.1',
          headers: {},
        },
      },
      order: ['iface-1'],
    });
    window.wirebench = {
      definition: { import: vi.fn(), close: vi.fn(), cancelImport: vi.fn() },
      request: { generate: generateFn, send: vi.fn(), cancel: vi.fn() },
      app: { version: vi.fn() },
      dialogs: { openFile: vi.fn(), openFolder: vi.fn() },
      files: { pathFor: vi.fn() },
      on: vi.fn(),
    };

    useProjectStore.getState().removeRequest('r1');
    const newId = await useProjectStore.getState().addRequest('iface-1', '{tns}B', 'Add');

    const draft = useProjectStore.getState().requests[newId];
    expect(draft?.name).toBe('Request 3');
  });

  it('addRequest ignores renamed drafts when determining next Request N', async () => {
    const generateFn = vi.fn().mockResolvedValue({ ok: true, value: generated('Add') });
    useProjectStore.setState({
      interfaces: { 'iface-1': summary },
      requests: {
        r1: {
          id: 'r1',
          interfaceId: 'iface-1',
          bindingName: '{tns}B',
          operationName: 'Add',
          name: 'Request 1',
          envelopeXml: 'x',
          soapVersion: '1.1',
          headers: {},
        },
        r2: {
          id: 'r2',
          interfaceId: 'iface-1',
          bindingName: '{tns}B',
          operationName: 'Add',
          name: 'Custom Name',
          envelopeXml: 'x',
          soapVersion: '1.1',
          headers: {},
        },
      },
      order: ['iface-1'],
    });
    window.wirebench = {
      definition: { import: vi.fn(), close: vi.fn(), cancelImport: vi.fn() },
      request: { generate: generateFn, send: vi.fn(), cancel: vi.fn() },
      app: { version: vi.fn() },
      dialogs: { openFile: vi.fn(), openFolder: vi.fn() },
      files: { pathFor: vi.fn() },
      on: vi.fn(),
    };

    const newId = await useProjectStore.getState().addRequest('iface-1', '{tns}B', 'Add');

    const draft = useProjectStore.getState().requests[newId];
    expect(draft?.name).toBe('Request 2');
  });
});
