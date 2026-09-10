import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectWire } from '../../src/shared/wire-types.js';
import { selectRequestEndpoint, selectRequestEndpointUrl } from '../../src/renderer/state/project-endpoint.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { PROJECT_SETTINGS, REQUEST_PROPERTIES } from '../helpers/wire-defaults.js';

const BINDING = '{tns}CalculatorSoap';

function projectWire(overrides: Partial<ProjectWire> = {}): ProjectWire {
  return {
    settings: PROJECT_SETTINGS,
    id: 'proj-1',
    name: 'Demo',
    dir: '/tmp/demo',
    dirty: false,
    interfaces: [
      {
        id: 'iface-1',
        name: 'Calculator',
        slug: 'Calculator',
        definitionUrl: 'http://example.test/service.wsdl',
        cacheDefinition: true,
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
          },
        ],
        problems: [],
        documentCount: 1,
        endpoints: [
          { id: 'ep-1', name: 'Primary', url: 'http://a.test/soap' },
          { id: 'ep-2', name: 'Staging', url: 'http://b.test/soap' },
        ],
        defaultEndpointId: 'ep-1',
        hydration: 'ready',
      },
    ],
    requests: [
      {
        properties: REQUEST_PROPERTIES,
        id: 'req-1',
        interfaceId: 'iface-1',
        bindingName: BINDING,
        operationName: 'Add',
        name: 'Request 1',
        envelopeXml: '<Add/>',
        soapVersion: '1.1',
        endpointId: 'ep-1',
        headers: [],
        order: 0,
      },
    ],
    properties: {},
    environments: [],
    problems: [],
    ...overrides,
  };
}

/** Resets the store to "no project open" between tests. */
function resetStore(): void {
  useProjectStore.setState({
    project: null,
    interfaces: {},
    requests: {},
    order: [],
    environments: [],
    activeEnvironmentId: undefined,
    saveStatus: 'idle',
    lastSavedAt: undefined,
    changedOnDisk: [],
  });
}

describe('useProjectStore', () => {
  beforeEach(() => {
    resetStore();
    installWirebenchApi();
  });

  it('applySnapshot indexes interfaces and requests by id', () => {
    useProjectStore.getState().applySnapshot(projectWire());
    const state = useProjectStore.getState();

    expect(state.project?.name).toBe('Demo');
    expect(state.order).toEqual(['iface-1']);
    expect(state.interfaces['iface-1']?.name).toBe('Calculator');
    expect(state.requests['req-1']?.envelopeXml).toBe('<Add/>');
  });

  it('applySnapshot(null) empties the mirror', () => {
    useProjectStore.getState().applySnapshot(projectWire());
    useProjectStore.getState().applySnapshot(null);
    expect(useProjectStore.getState()).toMatchObject({ project: null, interfaces: {}, requests: {}, order: [] });
  });

  it('importDefinition calls project.addInterface and mirrors the reply', async () => {
    const wire = projectWire();
    const addInterface = vi.fn().mockResolvedValue({ ok: true, value: { project: wire, interfaceId: 'iface-1' } });
    installWirebenchApi({ project: { addInterface } });

    const added = await useProjectStore
      .getState()
      .importDefinition({ kind: 'url', url: 'http://example.test/service.wsdl' }, undefined, 'tok-1');

    expect(addInterface).toHaveBeenCalledWith({
      source: { kind: 'url', url: 'http://example.test/service.wsdl' },
      token: 'tok-1',
    });
    expect(added.name).toBe('Calculator');
    expect(useProjectStore.getState().requests['req-1']).toBeDefined();
  });

  it('importDefinition surfaces an IPC failure as an Error carrying the code', async () => {
    installWirebenchApi({
      project: {
        addInterface: vi.fn().mockResolvedValue({ ok: false, error: { code: 'fetch-failed', message: 'boom' } }),
      },
    });
    await expect(
      useProjectStore.getState().importDefinition({ kind: 'url', url: 'http://nope.test/x.wsdl' }),
    ).rejects.toThrow('boom');
  });

  it('addRequest sends an add-request mutation and returns the created id', async () => {
    const wire = projectWire();
    const mutate = vi.fn().mockResolvedValue({ ok: true, value: { project: wire, createdRequestId: 'req-2' } });
    installWirebenchApi({ project: { mutate } });

    const id = await useProjectStore.getState().addRequest('iface-1', BINDING, 'Add');

    expect(id).toBe('req-2');
    expect(mutate).toHaveBeenCalledWith({
      change: { kind: 'add-request', interfaceId: 'iface-1', bindingName: BINDING, operationName: 'Add' },
    });
  });

  it('cloneRequest and removeRequest go through mutate', async () => {
    const wire = projectWire();
    const mutate = vi.fn().mockResolvedValue({ ok: true, value: { project: wire, createdRequestId: 'req-3' } });
    installWirebenchApi({ project: { mutate } });

    expect(await useProjectStore.getState().cloneRequest('req-1')).toBe('req-3');
    expect(mutate).toHaveBeenLastCalledWith({ change: { kind: 'clone-request', requestId: 'req-1' } });

    await useProjectStore.getState().removeRequest('req-1');
    expect(mutate).toHaveBeenLastCalledWith({ change: { kind: 'remove-request', requestId: 'req-1' } });
  });

  it('removeInterface goes through mutate', async () => {
    installWirebenchApi({
      project: {
        mutate: vi
          .fn()
          .mockResolvedValue({ ok: true, value: { project: projectWire({ interfaces: [], requests: [] }) } }),
      },
    });
    await useProjectStore.getState().removeInterface('iface-1');
    expect(useProjectStore.getState().order).toEqual([]);
  });

  it('updateRequest applies the edit locally before main replies, and keeps it afterwards', async () => {
    useProjectStore.getState().applySnapshot(projectWire());

    let resolveMutate: ((value: unknown) => void) | undefined;
    const mutate = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveMutate = resolve;
      }),
    );
    installWirebenchApi({ project: { mutate } });

    useProjectStore.getState().updateRequest('req-1', { envelopeXml: '<Add>typed</Add>' });
    // Optimistic: on screen immediately, without waiting for the round trip.
    expect(useProjectStore.getState().requests['req-1']?.envelopeXml).toBe('<Add>typed</Add>');

    // Main replies with the pre-edit snapshot (as a racing `project.changed` would); the
    // pending patch must survive that, or typing would visibly jump backwards.
    resolveMutate?.({ ok: true, value: { project: projectWire() } });
    await vi.waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        change: { kind: 'update-request', requestId: 'req-1', patch: { envelopeXml: '<Add>typed</Add>' } },
      });
    });
    expect(useProjectStore.getState().requests['req-1']?.envelopeXml).toBe('<Add>typed</Add>');
  });

  it('setEndpoint patches the request custom URL', () => {
    useProjectStore.getState().applySnapshot(projectWire());
    const mutate = vi.fn().mockResolvedValue({ ok: true, value: { project: projectWire() } });
    installWirebenchApi({ project: { mutate } });

    useProjectStore.getState().setEndpoint('req-1', 'http://custom.test/soap');
    expect(mutate).toHaveBeenCalledWith({
      change: { kind: 'update-request', requestId: 'req-1', patch: { endpointUrl: 'http://custom.test/soap' } },
    });
  });

  it('save() reports its progress and records when it finished', async () => {
    installWirebenchApi({
      project: {
        save: vi.fn().mockResolvedValue({
          ok: true,
          value: { saved: true, savedAt: '2026-09-10T08:00:00.000Z', written: 2, removed: 0 },
        }),
      },
    });
    await useProjectStore.getState().save();
    expect(useProjectStore.getState().saveStatus).toBe('saved');
    expect(useProjectStore.getState().lastSavedAt).toBe('2026-09-10T08:00:00.000Z');
  });

  it('save() sets saveStatus to error and rejects, without touching lastSavedAt, on failure', async () => {
    installWirebenchApi({
      project: {
        save: vi.fn().mockResolvedValue({ ok: false, error: { code: 'write-failed', message: 'disk full' } }),
      },
    });
    await expect(useProjectStore.getState().save()).rejects.toThrow('disk full');
    expect(useProjectStore.getState().saveStatus).toBe('error');
    expect(useProjectStore.getState().lastSavedAt).toBeUndefined();
  });

  it('updateRequest reverts the pending patch and toasts when main rejects the mutation', async () => {
    useProjectStore.getState().applySnapshot(projectWire());
    const mutate = vi.fn().mockResolvedValue({ ok: false, error: { code: 'no-project', message: 'boom' } });
    installWirebenchApi({ project: { mutate } });

    useProjectStore.getState().updateRequest('req-1', { envelopeXml: '<Add>typed</Add>' });
    expect(useProjectStore.getState().requests['req-1']?.envelopeXml).toBe('<Add>typed</Add>');

    await vi.waitFor(() => {
      expect(useProjectStore.getState().requests['req-1']?.envelopeXml).toBe('<Add/>');
    });
  });

  it('collects and clears the paths the watcher reports', () => {
    useProjectStore.getState().noteChangedOnDisk(['wirebench.yaml']);
    useProjectStore.getState().noteChangedOnDisk(['wirebench.yaml', 'interfaces/Calculator/interface.yaml']);
    expect(useProjectStore.getState().changedOnDisk).toEqual([
      'wirebench.yaml',
      'interfaces/Calculator/interface.yaml',
    ]);

    useProjectStore.getState().dismissChangedOnDisk();
    expect(useProjectStore.getState().changedOnDisk).toEqual([]);
  });
});

describe('selectRequestEndpoint', () => {
  beforeEach(() => {
    resetStore();
    installWirebenchApi();
  });

  const resolve = (requestId: string) => selectRequestEndpoint(useProjectStore.getState(), requestId);

  it('prefers the request custom URL, then its endpoint, then the interface default', () => {
    useProjectStore.getState().applySnapshot(projectWire());
    expect(resolve('req-1')).toEqual({ url: 'http://a.test/soap', source: 'request-endpoint' });

    const wire = projectWire();
    useProjectStore.getState().applySnapshot({
      ...wire,
      requests: [{ ...wire.requests[0]!, endpointId: 'ep-2' }],
    });
    expect(resolve('req-1')).toEqual({ url: 'http://b.test/soap', source: 'request-endpoint' });

    useProjectStore.getState().applySnapshot({
      ...wire,
      requests: [{ ...wire.requests[0]!, endpointUrl: 'http://custom.test/soap' }],
    });
    expect(resolve('req-1')).toEqual({ url: 'http://custom.test/soap', source: 'request-custom' });
  });

  it('falls back to the interface default, then its first endpoint, then nothing', () => {
    const wire = projectWire();
    const withoutDefault = { ...wire.interfaces[0]! };
    delete withoutDefault.defaultEndpointId;

    useProjectStore.getState().applySnapshot({
      ...wire,
      interfaces: [withoutDefault],
      requests: [{ ...wire.requests[0]!, endpointId: undefined }],
    });
    expect(resolve('req-1')).toEqual({ url: 'http://a.test/soap', source: 'interface-default' });

    useProjectStore.getState().applySnapshot({
      ...wire,
      interfaces: [{ ...withoutDefault, endpoints: [] }],
      requests: [{ ...wire.requests[0]!, endpointId: undefined }],
    });
    expect(resolve('req-1')).toEqual({ source: 'none' });
    expect(resolve('nope')).toEqual({ source: 'none' });
    expect(selectRequestEndpointUrl(useProjectStore.getState(), 'req-1')).toBeUndefined();
  });

  it("lets the active environment's override for the interface slug beat everything else", () => {
    const wire = projectWire();
    const environment = {
      id: 'env-1',
      name: 'Dev',
      slug: 'Dev',
      order: 0,
      endpoints: { Calculator: 'http://dev.test/soap' },
      properties: {},
    };

    // Present but not active: the request's own custom URL still wins.
    useProjectStore.getState().applySnapshot({
      ...wire,
      environments: [environment],
      requests: [{ ...wire.requests[0]!, endpointUrl: 'http://custom.test/soap' }],
    });
    expect(resolve('req-1')).toEqual({ url: 'http://custom.test/soap', source: 'request-custom' });

    useProjectStore.getState().applySnapshot({
      ...wire,
      environments: [environment],
      activeEnvironmentId: 'env-1',
      requests: [{ ...wire.requests[0]!, endpointUrl: 'http://custom.test/soap' }],
    });
    expect(resolve('req-1')).toEqual({ url: 'http://dev.test/soap', source: 'environment' });

    // An environment with no override for this interface's slug falls through.
    useProjectStore.getState().applySnapshot({
      ...wire,
      environments: [{ ...environment, endpoints: { Other: 'http://other.test/soap' } }],
      activeEnvironmentId: 'env-1',
    });
    expect(resolve('req-1')).toEqual({ url: 'http://a.test/soap', source: 'request-endpoint' });
  });
});

describe('useProjectStore: environments and properties', () => {
  beforeEach(() => {
    resetStore();
  });

  /** Stubs `project.mutate`, returning the reply and capturing the change it was sent. */
  function stubMutate(value: Record<string, unknown> = {}) {
    const mutate = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { project: projectWire({ environments: [] }), ...value } });
    installWirebenchApi({ project: { mutate } });
    return mutate;
  }

  it('mirrors environments (in order) and the active environment id', () => {
    useProjectStore.getState().applySnapshot(
      projectWire({
        environments: [
          { id: 'env-2', name: 'Prod', slug: 'Prod', order: 1, endpoints: {}, properties: {} },
          { id: 'env-1', name: 'Dev', slug: 'Dev', order: 0, endpoints: {}, properties: { who: 'ada' } },
        ],
        activeEnvironmentId: 'env-1',
      }),
    );

    const state = useProjectStore.getState();
    expect(state.environments.map((environment) => environment.name)).toEqual(['Dev', 'Prod']);
    expect(state.activeEnvironmentId).toBe('env-1');
  });

  it('addEnvironment sends add-environment and returns the created id', async () => {
    const mutate = stubMutate({ createdEnvironmentId: 'env-9' });

    await expect(useProjectStore.getState().addEnvironment('Dev')).resolves.toBe('env-9');
    expect(mutate).toHaveBeenCalledWith({ change: { kind: 'add-environment', name: 'Dev' } });
  });

  it('addEnvironment fails loudly when main returns no id', async () => {
    stubMutate();
    await expect(useProjectStore.getState().addEnvironment('Dev')).rejects.toThrow(/environment id/);
  });

  it('updateEnvironment, removeEnvironment and setActiveEnvironment send their change', async () => {
    const mutate = stubMutate();

    await useProjectStore.getState().updateEnvironment('env-1', { properties: { who: 'ada' } });
    await useProjectStore.getState().removeEnvironment('env-1');
    await useProjectStore.getState().setActiveEnvironment('env-1');
    await useProjectStore.getState().setActiveEnvironment(null);

    expect(mutate.mock.calls.map((call) => (call[0] as { change: unknown }).change)).toEqual([
      { kind: 'update-environment', environmentId: 'env-1', patch: { properties: { who: 'ada' } } },
      { kind: 'remove-environment', environmentId: 'env-1' },
      { kind: 'set-active-environment', environmentId: 'env-1' },
      { kind: 'set-active-environment', environmentId: null },
    ]);
  });

  it('setProjectProperty and removeProjectProperty send their change', async () => {
    const mutate = stubMutate();

    await useProjectStore.getState().setProjectProperty('who', 'ada');
    await useProjectStore.getState().removeProjectProperty('who');

    expect(mutate.mock.calls.map((call) => (call[0] as { change: unknown }).change)).toEqual([
      { kind: 'set-project-property', name: 'who', value: 'ada' },
      { kind: 'remove-project-property', name: 'who' },
    ]);
  });

  it('builds each updateEnvironment endpoints patch from the latest pending state, not a stale snapshot', () => {
    useProjectStore.getState().applySnapshot(
      projectWire({
        environments: [{ id: 'env-1', name: 'Dev', slug: 'Dev', order: 0, endpoints: {}, properties: {} }],
      }),
    );

    const mutate = vi.fn().mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves: both commits are in flight at once */
        }),
    );
    installWirebenchApi({ project: { mutate } });

    const store = useProjectStore.getState();
    // Neither commit is awaited before the next fires — this is the race: two endpoint
    // overrides on different interfaces, committed back-to-back.
    void store.updateEnvironment('env-1', {
      endpoints: { ...store.environments[0]?.endpoints, calculator: 'http://one.test/soap' },
    });
    const latest = useProjectStore.getState();
    void latest.updateEnvironment('env-1', {
      endpoints: { ...latest.environments[0]?.endpoints, weather: 'http://two.test/soap' },
    });

    expect(mutate).toHaveBeenCalledTimes(2);
    const secondPatch = (mutate.mock.calls[1]?.[0] as { change: { patch: { endpoints: Record<string, string> } } })
      .change.patch;
    expect(secondPatch.endpoints).toEqual({
      calculator: 'http://one.test/soap',
      weather: 'http://two.test/soap',
    });
  });

  it('surfaces a failed environment mutation as an Error carrying the code', async () => {
    installWirebenchApi({
      project: { mutate: vi.fn().mockResolvedValue({ ok: false, error: { code: 'not-found', message: 'gone' } }) },
    });

    await expect(useProjectStore.getState().removeEnvironment('nope')).rejects.toThrow('gone');
  });
});
