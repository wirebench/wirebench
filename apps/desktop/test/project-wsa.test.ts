import { describe, expect, it, vi } from 'vitest';
import { createInterface, createProject, createRequest, DEFAULT_WSA_CONFIG, resolveScopes } from '@wirebench/engine';
import type { Interface, Project } from '@wirebench/engine';
import { applyChange } from '../src/main/project-mutations.js';
import type { MutationDeps } from '../src/main/project-mutations.js';
import { findRequest, toInterfaceWire, toRequestWire } from '../src/main/project-wire.js';
import { preflightRequest } from '../src/main/expansion-preflight.js';
import { registerWsaChannels } from '../src/main/ipc/wsa.js';

const BINDING = '{urn:wb:wsa}WsaBinding';

const deps: MutationDeps = {
  generate: () => Promise.resolve({ envelopeXml: '<Echo/>', soapVersion: '1.1' }),
};

function build(): Project {
  const iface: Interface = createInterface('WsaService', {
    id: 'iface-1',
    definitionUrl: 'http://example.test/service.wsdl',
    endpoints: [{ id: 'ep-1', name: 'Primary', url: 'http://a.test/soap', authMode: 'complement' }],
    operations: [
      {
        name: 'Echo',
        bindingName: BINDING,
        slug: 'Echo',
        order: 0,
        requests: [
          createRequest('Request 1', {
            id: 'req-1',
            envelopeXml: '<Echo/>',
            soapVersion: '1.1',
            soapAction: 'urn:wb:wsa:Echo',
            endpointId: 'ep-1',
          }),
        ],
      },
    ],
  });
  return { ...createProject('Demo', { id: 'proj-1' }), interfaces: [iface] };
}

describe('update-interface-wsa / update-request-wsa', () => {
  it('fills the engine defaults in for a partial interface patch', async () => {
    const { project } = await applyChange(
      build(),
      { kind: 'update-interface-wsa', interfaceId: 'iface-1', wsa: { enabled: true, action: 'urn:iface' } },
      deps,
    );
    expect(project.interfaces[0]?.wsa).toEqual({ ...DEFAULT_WSA_CONFIG, enabled: true, action: 'urn:iface' });
  });

  it('sets and clears a request’s own overrides', async () => {
    const set = await applyChange(
      build(),
      { kind: 'update-request-wsa', requestId: 'req-1', wsa: { enabled: true, to: 'urn:to' } },
      deps,
    );
    expect(findRequest(set.project, 'req-1')?.request.wsa?.to).toBe('urn:to');
    const cleared = await applyChange(set.project, { kind: 'update-request-wsa', requestId: 'req-1', wsa: null }, deps);
    const request = findRequest(cleared.project, 'req-1')?.request;
    expect(request).toBeDefined();
    expect(request !== undefined && 'wsa' in request).toBe(false);
  });

  it('carries both levels onto the wire', async () => {
    const { project } = await applyChange(
      build(),
      { kind: 'update-interface-wsa', interfaceId: 'iface-1', wsa: { enabled: true } },
      deps,
    );
    const iface = project.interfaces[0];
    expect(iface).toBeDefined();
    expect(toInterfaceWire(iface as Interface, undefined).wsaConfig?.enabled).toBe(true);
    const location = findRequest(project, 'req-1');
    expect(location).toBeDefined();
    expect(
      location === undefined ? undefined : toRequestWire(location.iface, location.operation, location.request).wsa,
    ).toBeUndefined();
  });
});

describe('preflight WS-Addressing', () => {
  it('reports the merged, resolved headers a send would carry', async () => {
    const { project } = await applyChange(
      build(),
      { kind: 'update-interface-wsa', interfaceId: 'iface-1', wsa: { enabled: true } },
      deps,
    );
    const result = preflightRequest(
      project,
      'req-1',
      resolveScopes(project, undefined, {}, {}),
      undefined,
      'urn:default',
    );
    expect(result.wsa).toEqual({
      enabled: true,
      action: 'urn:wb:wsa:Echo',
      to: 'http://a.test/soap',
      messageId: 'auto',
    });
  });

  it('reports disabled addressing as such, with no fields', () => {
    expect(preflightRequest(build(), 'req-1', resolveScopes(build(), undefined, {}, {})).wsa).toEqual({
      enabled: false,
    });
  });
});

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

describe('the wsa.* channels', () => {
  it('route insert and remove to the project service', async () => {
    const project = {
      insertWsaHeaders: vi.fn().mockReturnValue('<addressed/>'),
      removeWsaHeadersFrom: vi.fn().mockReturnValue('<clean/>'),
    };
    registerWsaChannels({ project });
    const inserted = await handlers.get('wsa.insertHeaders')?.({}, { requestId: 'req-1', envelopeXml: '<x/>' });
    expect(inserted).toMatchObject({ ok: true, value: { envelopeXml: '<addressed/>' } });
    expect(project.insertWsaHeaders).toHaveBeenCalledWith('req-1', '<x/>');
    const removed = await handlers.get('wsa.removeHeaders')?.({}, { requestId: 'req-1' });
    expect(removed).toMatchObject({ ok: true, value: { envelopeXml: '<clean/>' } });
  });
});
