import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectWire } from '../../src/shared/wire-types.js';
import { selectRequestEndpoint, selectRequestEndpointUrl } from '../../src/renderer/state/project-endpoint.js';
import { selectEnvironment, selectProjectEnvironments, useProjectStore } from '../../src/renderer/state/project.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { workspaceWire } from '../helpers/workspace-wire.js';
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
            inputMimeParts: [],
          },
        ],
        problems: [],
        documentCount: 1,
        endpoints: [
          { id: 'ep-1', name: 'Primary', url: 'http://a.test/soap', authMode: 'override' },
          { id: 'ep-2', name: 'Staging', url: 'http://b.test/soap', authMode: 'override' },
        ],
        defaultEndpointId: 'ep-1',
        hydration: 'ready',
      },
    ],
    requests: [
      {
        properties: REQUEST_PROPERTIES,
        attachments: [],
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
    disabledProperties: [],
    environments: [],
    problems: [],
    keystores: [],
    wssOutgoing: [],
    wssIncoming: [],
    ...overrides,
  };
}

/** Resets the store to "no project open" between tests. */
function resetStore(): void {
  useProjectStore.getState().reset();
  useWorkspaceStore.setState({ workspace: null });
}

/** Mirrors `projectWire(overrides)` under its own id, as `project.changed` would. */
function applyProject(overrides: Partial<ProjectWire> = {}): ProjectWire {
  const wire = projectWire(overrides);
  useProjectStore.getState().applySnapshot(wire.id, wire);
  return wire;
}

describe('useProjectStore', () => {
  beforeEach(() => {
    resetStore();
    installWirebenchApi();
  });

  it('applySnapshot indexes interfaces and requests by id', () => {
    applyProject();
    const state = useProjectStore.getState();

    expect(state.projects['proj-1']?.name).toBe('Demo');
    expect(state.order).toEqual([{ projectId: 'proj-1', interfaceIds: ['iface-1'] }]);
    expect(state.interfaces['iface-1']?.name).toBe('Calculator');
    expect(state.requests['req-1']?.envelopeXml).toBe('<Add/>');
  });

  it('applySnapshot(id, null) removes that project from the mirror', () => {
    applyProject();
    useProjectStore.getState().applySnapshot('proj-1', null);
    expect(useProjectStore.getState()).toMatchObject({
      projects: {},
      interfaces: {},
      requests: {},
      order: [],
      projectOf: {},
    });
  });

  it('importDefinition calls project.addInterface and mirrors the reply', async () => {
    const wire = projectWire();
    const addInterface = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { projectId: 'proj-1', project: wire, interfaceId: 'iface-1' } });
    installWirebenchApi({ project: { addInterface } });

    const added = await useProjectStore
      .getState()
      .importDefinition(
        { newProjectName: 'Demo' },
        { kind: 'url', url: 'http://example.test/service.wsdl' },
        undefined,
        'tok-1',
      );

    expect(addInterface).toHaveBeenCalledWith({
      target: { newProjectName: 'Demo' },
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
      useProjectStore
        .getState()
        .importDefinition({ projectId: 'proj-1' }, { kind: 'url', url: 'http://nope.test/x.wsdl' }),
    ).rejects.toThrow('boom');
  });

  it('addRequest sends an add-request mutation and returns the created id', async () => {
    applyProject();
    const wire = projectWire();
    const mutate = vi.fn().mockResolvedValue({ ok: true, value: { project: wire, createdRequestId: 'req-2' } });
    installWirebenchApi({ project: { mutate } });

    const id = await useProjectStore.getState().addRequest('iface-1', BINDING, 'Add');

    expect(id).toBe('req-2');
    expect(mutate).toHaveBeenCalledWith({
      projectId: 'proj-1',
      change: { kind: 'add-request', interfaceId: 'iface-1', bindingName: BINDING, operationName: 'Add' },
    });
  });

  it('cloneRequest and removeRequest go through mutate', async () => {
    applyProject();
    const wire = projectWire();
    const mutate = vi.fn().mockResolvedValue({ ok: true, value: { project: wire, createdRequestId: 'req-3' } });
    installWirebenchApi({ project: { mutate } });

    expect(await useProjectStore.getState().cloneRequest('req-1')).toBe('req-3');
    expect(mutate).toHaveBeenLastCalledWith({
      projectId: 'proj-1',
      change: { kind: 'clone-request', requestId: 'req-1' },
    });

    await useProjectStore.getState().removeRequest('req-1');
    expect(mutate).toHaveBeenLastCalledWith({
      projectId: 'proj-1',
      change: { kind: 'remove-request', requestId: 'req-1' },
    });
  });

  it('removeInterface goes through mutate', async () => {
    applyProject();
    installWirebenchApi({
      project: {
        mutate: vi
          .fn()
          .mockResolvedValue({ ok: true, value: { project: projectWire({ interfaces: [], requests: [] }) } }),
      },
    });
    await useProjectStore.getState().removeInterface('iface-1');
    expect(useProjectStore.getState().order).toEqual([{ projectId: 'proj-1', interfaceIds: [] }]);
  });

  it('updateRequest applies the edit locally before main replies, and keeps it afterwards', async () => {
    applyProject();

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
        projectId: 'proj-1',
        change: { kind: 'update-request', requestId: 'req-1', patch: { envelopeXml: '<Add>typed</Add>' } },
      });
    });
    expect(useProjectStore.getState().requests['req-1']?.envelopeXml).toBe('<Add>typed</Add>');
  });

  it('setEndpoint patches the request custom URL', () => {
    applyProject();
    const mutate = vi.fn().mockResolvedValue({ ok: true, value: { project: projectWire() } });
    installWirebenchApi({ project: { mutate } });

    useProjectStore.getState().setEndpoint('req-1', 'http://custom.test/soap');
    expect(mutate).toHaveBeenCalledWith({
      projectId: 'proj-1',
      change: { kind: 'update-request', requestId: 'req-1', patch: { endpointUrl: 'http://custom.test/soap' } },
    });
  });

  it("save() saves every open project and reports each one's status", async () => {
    applyProject();
    applyProject({ id: 'proj-2', name: 'Billing', interfaces: [], requests: [] });
    const save = vi.fn().mockResolvedValue({
      ok: true,
      value: { saved: true, savedAt: '2026-09-10T08:00:00.000Z', written: 2, removed: 0 },
    });
    installWirebenchApi({ project: { save } });

    await useProjectStore.getState().save();

    expect(save.mock.calls.map((call) => call[0] as unknown)).toEqual([
      { projectId: 'proj-1' },
      { projectId: 'proj-2' },
    ]);
    expect(useProjectStore.getState().saveStatus).toEqual({ 'proj-1': 'saved', 'proj-2': 'saved' });
  });

  it('save(projectId) saves only that project, and marks it as errored on failure', async () => {
    applyProject();
    applyProject({ id: 'proj-2', name: 'Billing', interfaces: [], requests: [] });
    const save = vi.fn().mockResolvedValue({ ok: false, error: { code: 'write-failed', message: 'disk full' } });
    installWirebenchApi({ project: { save } });

    await expect(useProjectStore.getState().save('proj-2')).rejects.toThrow('disk full');
    expect(save).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().saveStatus).toEqual({ 'proj-2': 'error' });
  });

  it('updateRequest reverts the pending patch and toasts when main rejects the mutation', async () => {
    applyProject();
    const mutate = vi.fn().mockResolvedValue({ ok: false, error: { code: 'no-project', message: 'boom' } });
    installWirebenchApi({ project: { mutate } });

    useProjectStore.getState().updateRequest('req-1', { envelopeXml: '<Add>typed</Add>' });
    expect(useProjectStore.getState().requests['req-1']?.envelopeXml).toBe('<Add>typed</Add>');

    await vi.waitFor(() => {
      expect(useProjectStore.getState().requests['req-1']?.envelopeXml).toBe('<Add/>');
    });
  });

  it('collects and clears the paths the watcher reports, per project', () => {
    useProjectStore.getState().noteChangedOnDisk('proj-1', ['wirebench.yaml']);
    useProjectStore.getState().noteChangedOnDisk('proj-1', ['wirebench.yaml', 'interfaces/Calculator/interface.yaml']);
    useProjectStore.getState().noteChangedOnDisk('proj-2', ['wirebench.yaml']);
    expect(useProjectStore.getState().changedOnDisk).toEqual({
      'proj-1': ['wirebench.yaml', 'interfaces/Calculator/interface.yaml'],
      'proj-2': ['wirebench.yaml'],
    });

    useProjectStore.getState().dismissChangedOnDisk('proj-1');
    expect(useProjectStore.getState().changedOnDisk).toEqual({ 'proj-1': [], 'proj-2': ['wirebench.yaml'] });
  });
});

describe('selectRequestEndpoint', () => {
  beforeEach(() => {
    resetStore();
    installWirebenchApi();
  });

  const resolve = (requestId: string) =>
    selectRequestEndpoint(useProjectStore.getState(), useWorkspaceStore.getState().workspace, requestId);

  it('prefers the request custom URL, then its endpoint, then the interface default', () => {
    applyProject();
    expect(resolve('req-1')).toEqual({ url: 'http://a.test/soap', source: 'request-endpoint' });

    const wire = projectWire();
    useProjectStore.getState().applySnapshot('proj-1', {
      ...wire,
      requests: [{ ...wire.requests[0]!, endpointId: 'ep-2' }],
    });
    expect(resolve('req-1')).toEqual({ url: 'http://b.test/soap', source: 'request-endpoint' });

    useProjectStore.getState().applySnapshot('proj-1', {
      ...wire,
      requests: [{ ...wire.requests[0]!, endpointUrl: 'http://custom.test/soap' }],
    });
    expect(resolve('req-1')).toEqual({ url: 'http://custom.test/soap', source: 'request-custom' });
  });

  it('falls back to the interface default, then its first endpoint, then nothing', () => {
    const wire = projectWire();
    const withoutDefault = { ...wire.interfaces[0]! };
    delete withoutDefault.defaultEndpointId;

    useProjectStore.getState().applySnapshot('proj-1', {
      ...wire,
      interfaces: [withoutDefault],
      requests: [{ ...wire.requests[0]!, endpointId: undefined }],
    });
    expect(resolve('req-1')).toEqual({ url: 'http://a.test/soap', source: 'interface-default' });

    useProjectStore.getState().applySnapshot('proj-1', {
      ...wire,
      interfaces: [{ ...withoutDefault, endpoints: [] }],
      requests: [{ ...wire.requests[0]!, endpointId: undefined }],
    });
    expect(resolve('req-1')).toEqual({ source: 'none' });
    expect(resolve('nope')).toEqual({ source: 'none' });
    expect(selectRequestEndpointUrl(useProjectStore.getState(), null, 'req-1')).toBeUndefined();
  });

  it("lets the workspace's active environment override beat everything else", () => {
    const environment = {
      id: 'env-1',
      name: 'Dev',
      slug: 'Dev',
      order: 0,
      endpoints: { 'Demo/Calculator': 'http://dev.test/soap' },
      properties: {},
      disabled: [],
    };
    const projects = [
      {
        id: 'proj-1',
        name: 'Demo',
        slug: 'Demo',
        source: 'internal' as const,
        dir: '/w/Demo',
        status: 'ready' as const,
      },
    ];
    const wire = projectWire();
    useProjectStore.getState().applySnapshot('proj-1', {
      ...wire,
      requests: [{ ...wire.requests[0]!, endpointUrl: 'http://custom.test/soap' }],
    });

    // Present but not active: the request's own custom URL still wins.
    useWorkspaceStore.setState({ workspace: workspaceWire({ environments: [environment], projects }) });
    expect(resolve('req-1')).toEqual({ url: 'http://custom.test/soap', source: 'request-custom' });

    // Active: the override keyed `<projectSlug>/<interfaceSlug>` wins, and says where it came from.
    useWorkspaceStore.setState({
      workspace: workspaceWire({ environments: [environment], activeEnvironmentId: 'env-1', projects }),
    });
    expect(resolve('req-1')).toEqual({ url: 'http://dev.test/soap', source: 'workspace-environment' });

    // An environment with no override for this project's interface falls through.
    useWorkspaceStore.setState({
      workspace: workspaceWire({
        environments: [{ ...environment, endpoints: { 'Other/Calculator': 'http://other.test/soap' } }],
        activeEnvironmentId: 'env-1',
        projects,
      }),
    });
    expect(resolve('req-1')).toEqual({ url: 'http://custom.test/soap', source: 'request-custom' });
  });

  it("lets a linked project's own environment beat the workspace environment's override", () => {
    const workspaceEnvironment = {
      id: 'env-1',
      name: 'Dev',
      slug: 'Dev',
      order: 0,
      endpoints: { 'Demo/Calculator': 'http://dev.test/soap' },
      properties: {},
      disabled: [],
    };
    const projects = [
      {
        id: 'proj-1',
        name: 'Demo',
        slug: 'Demo',
        source: 'linked' as const,
        dir: '/elsewhere/Demo',
        status: 'ready' as const,
      },
    ];

    // The linked project's own environment (matched by slug 'Dev') overrides the interface too:
    // it wins over the workspace environment's override for the same interface.
    applyProject({
      environments: [
        {
          id: 'proj-env-1',
          name: 'Dev',
          slug: 'Dev',
          order: 0,
          endpoints: { Calculator: 'http://linked-dev.test/soap' },
          properties: {},
          disabled: [],
        },
      ],
    });
    useWorkspaceStore.setState({
      workspace: workspaceWire({ environments: [workspaceEnvironment], activeEnvironmentId: 'env-1', projects }),
    });
    expect(resolve('req-1')).toEqual({ url: 'http://linked-dev.test/soap', source: 'environment' });

    // The linked project's environment has no override for this interface: falls through to the
    // workspace environment's override (the unchanged case).
    applyProject({
      environments: [
        { id: 'proj-env-1', name: 'Dev', slug: 'Dev', order: 0, endpoints: {}, properties: {}, disabled: [] },
      ],
    });
    expect(resolve('req-1')).toEqual({ url: 'http://dev.test/soap', source: 'workspace-environment' });

    // No environment of the linked project matches the active workspace environment's slug:
    // falls through the same way.
    applyProject({
      environments: [
        {
          id: 'proj-env-1',
          name: 'Prod',
          slug: 'Prod',
          order: 0,
          endpoints: { Calculator: 'http://linked-prod.test/soap' },
          properties: {},
          disabled: [],
        },
      ],
    });
    expect(resolve('req-1')).toEqual({ url: 'http://dev.test/soap', source: 'workspace-environment' });
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

  it("reads a project's environments in order", () => {
    applyProject({
      environments: [
        { id: 'env-2', name: 'Prod', slug: 'Prod', order: 1, endpoints: {}, properties: {}, disabled: [] },
        { id: 'env-1', name: 'Dev', slug: 'Dev', order: 0, endpoints: {}, properties: { who: 'ada' }, disabled: [] },
      ],
    });

    const state = useProjectStore.getState();
    expect(selectProjectEnvironments(state, 'proj-1').map((environment) => environment.name)).toEqual(['Dev', 'Prod']);
    expect(selectEnvironment(state, 'env-1')?.properties).toEqual({ who: 'ada' });
    expect(state.projectOf['env-2']).toBe('proj-1');
  });

  it('addEnvironment sends add-environment to the named project and returns the created id', async () => {
    const mutate = stubMutate({ createdEnvironmentId: 'env-9' });

    await expect(useProjectStore.getState().addEnvironment('proj-1', 'Dev')).resolves.toBe('env-9');
    expect(mutate).toHaveBeenCalledWith({ projectId: 'proj-1', change: { kind: 'add-environment', name: 'Dev' } });
  });

  it('addEnvironment fails loudly when main returns no id', async () => {
    stubMutate();
    await expect(useProjectStore.getState().addEnvironment('proj-1', 'Dev')).rejects.toThrow(/environment id/);
  });

  it('updateEnvironment and removeEnvironment send their change to the named project', async () => {
    const mutate = stubMutate();

    await useProjectStore.getState().updateEnvironment('proj-1', 'env-1', { properties: { who: 'ada' } });
    await useProjectStore.getState().removeEnvironment('proj-1', 'env-1');

    expect(mutate.mock.calls.map((call) => call[0] as unknown)).toEqual([
      {
        projectId: 'proj-1',
        change: { kind: 'update-environment', environmentId: 'env-1', patch: { properties: { who: 'ada' } } },
      },
      { projectId: 'proj-1', change: { kind: 'remove-environment', environmentId: 'env-1' } },
    ]);
  });

  it('setProjectProperty and removeProjectProperty send their change to the named project', async () => {
    const mutate = stubMutate();

    await useProjectStore.getState().setProjectProperty('proj-1', 'who', 'ada');
    await useProjectStore.getState().removeProjectProperty('proj-1', 'who');

    expect(mutate.mock.calls.map((call) => call[0] as unknown)).toEqual([
      { projectId: 'proj-1', change: { kind: 'set-project-property', name: 'who', value: 'ada' } },
      { projectId: 'proj-1', change: { kind: 'remove-project-property', name: 'who' } },
    ]);
  });

  it('builds each updateEnvironment endpoints patch from the latest pending state, not a stale snapshot', () => {
    applyProject({
      environments: [{ id: 'env-1', name: 'Dev', slug: 'Dev', order: 0, endpoints: {}, properties: {}, disabled: [] }],
    });

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
    void store.updateEnvironment('proj-1', 'env-1', {
      endpoints: { ...selectEnvironment(store, 'env-1')?.endpoints, calculator: 'http://one.test/soap' },
    });
    const latest = useProjectStore.getState();
    void latest.updateEnvironment('proj-1', 'env-1', {
      endpoints: { ...selectEnvironment(latest, 'env-1')?.endpoints, weather: 'http://two.test/soap' },
    });

    expect(mutate).toHaveBeenCalledTimes(2);
    const secondPatch = (mutate.mock.calls[1]?.[0] as { change: { patch: { endpoints: Record<string, string> } } })
      .change.patch;
    expect(secondPatch.endpoints).toEqual({
      calculator: 'http://one.test/soap',
      weather: 'http://two.test/soap',
    });
    // The optimistic copy is handed out as one stable object, so a hook selector reading it
    // does not rerender forever while the edit is in flight.
    expect(selectEnvironment(useProjectStore.getState(), 'env-1')).toBe(
      selectEnvironment(useProjectStore.getState(), 'env-1'),
    );
  });

  it('surfaces a failed environment mutation as an Error carrying the code', async () => {
    installWirebenchApi({
      project: { mutate: vi.fn().mockResolvedValue({ ok: false, error: { code: 'not-found', message: 'gone' } }) },
    });

    await expect(useProjectStore.getState().removeEnvironment('proj-1', 'nope')).rejects.toThrow('gone');
  });
});

describe('useProjectStore attachments', () => {
  const attachment = {
    id: 'att-1',
    name: 'logo.png',
    contentType: 'image/png',
    size: 12,
    type: 'UNKNOWN' as const,
    contentId: 'att-1@wirebench',
    cached: true,
    source: { kind: 'cache' as const, sha256: 'c'.repeat(64) },
  };

  /** The snapshot with `req-1` already carrying {@link attachment}. */
  function withAttachment(): ProjectWire {
    const base = projectWire();
    return { ...base, requests: base.requests.map((request) => ({ ...request, attachments: [attachment] })) };
  }

  beforeEach(() => {
    resetStore();
    installWirebenchApi();
  });

  it('addAttachment sends only the path and returns the created id', async () => {
    applyProject();
    const mutate = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { project: withAttachment(), createdAttachmentId: 'att-1' } });
    installWirebenchApi({ project: { mutate } });

    const id = await useProjectStore.getState().addAttachment('req-1', '/files/logo.png');

    expect(id).toBe('att-1');
    expect(mutate).toHaveBeenCalledWith({
      projectId: 'proj-1',
      change: { kind: 'add-attachment', requestId: 'req-1', path: '/files/logo.png', copyToCache: true },
    });
    expect(useProjectStore.getState().requests['req-1']?.attachments).toEqual([attachment]);
  });

  it('addAttachment passes copyToCache: false and an explicit content type through', async () => {
    applyProject();
    const mutate = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { project: withAttachment(), createdAttachmentId: 'att-1' } });
    installWirebenchApi({ project: { mutate } });

    await useProjectStore
      .getState()
      .addAttachment('req-1', '/files/a.bin', { copyToCache: false, contentType: 'application/x-thing' });

    expect(mutate).toHaveBeenCalledWith({
      projectId: 'proj-1',
      change: {
        kind: 'add-attachment',
        requestId: 'req-1',
        path: '/files/a.bin',
        copyToCache: false,
        contentType: 'application/x-thing',
      },
    });
  });

  it('addAttachment rejects when main returns no id', async () => {
    applyProject();
    installWirebenchApi({
      project: { mutate: vi.fn().mockResolvedValue({ ok: true, value: { project: withAttachment() } }) },
    });
    await expect(useProjectStore.getState().addAttachment('req-1', '/files/a.png')).rejects.toThrow(/attachment id/);
  });

  it('updateAttachment applies the patch optimistically, then keeps main’s reply', async () => {
    useProjectStore.getState().applySnapshot('proj-1', withAttachment());
    let resolveMutate: ((value: unknown) => void) | undefined;
    const mutate = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveMutate = resolve;
      }),
    );
    installWirebenchApi({ project: { mutate } });

    useProjectStore.getState().updateAttachment('req-1', 'att-1', { contentType: 'image/webp', part: 'file' });
    expect(useProjectStore.getState().requests['req-1']?.attachments[0]).toMatchObject({
      contentType: 'image/webp',
      part: 'file',
    });

    const confirmed = withAttachment();
    confirmed.requests[0]!.attachments = [{ ...attachment, contentType: 'image/webp', part: 'file' }];
    resolveMutate?.({ ok: true, value: { project: confirmed } });
    await vi.waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        projectId: 'proj-1',
        change: {
          kind: 'update-attachment',
          requestId: 'req-1',
          attachmentId: 'att-1',
          patch: { contentType: 'image/webp', part: 'file' },
        },
      });
    });
    expect(useProjectStore.getState().requests['req-1']?.attachments[0]?.contentType).toBe('image/webp');
  });

  it('updateAttachment with part: null clears the part in the mirror', () => {
    const base = withAttachment();
    base.requests[0]!.attachments = [{ ...attachment, part: 'file' }];
    useProjectStore.getState().applySnapshot('proj-1', base);
    installWirebenchApi({ project: { mutate: vi.fn().mockReturnValue(new Promise(() => undefined)) } });

    useProjectStore.getState().updateAttachment('req-1', 'att-1', { part: null });

    expect(useProjectStore.getState().requests['req-1']?.attachments[0]?.part).toBeUndefined();
  });

  it('updateAttachment reverts to the confirmed snapshot when main rejects it', async () => {
    useProjectStore.getState().applySnapshot('proj-1', withAttachment());
    const mutate = vi.fn().mockResolvedValue({ ok: false, error: { code: 'not-found', message: 'gone' } });
    installWirebenchApi({ project: { mutate } });

    useProjectStore.getState().updateAttachment('req-1', 'att-1', { name: 'renamed.png' });

    await vi.waitFor(() => {
      expect(useProjectStore.getState().requests['req-1']?.attachments[0]?.name).toBe('logo.png');
    });
  });

  it('removeAttachment mutates and mirrors the reply', async () => {
    useProjectStore.getState().applySnapshot('proj-1', withAttachment());
    const mutate = vi.fn().mockResolvedValue({ ok: true, value: { project: projectWire() } });
    installWirebenchApi({ project: { mutate } });

    await useProjectStore.getState().removeAttachment('req-1', 'att-1');

    expect(mutate).toHaveBeenCalledWith({
      projectId: 'proj-1',
      change: { kind: 'remove-attachment', requestId: 'req-1', attachmentId: 'att-1' },
    });
    expect(useProjectStore.getState().requests['req-1']?.attachments).toEqual([]);
  });
});

describe('useProjectStore: several projects at once', () => {
  beforeEach(() => {
    resetStore();
    installWirebenchApi();
  });

  /** A second project with its own interface, request, keystore and environment ids. */
  function billing(): ProjectWire {
    const base = projectWire();
    return {
      ...base,
      id: 'proj-2',
      name: 'Billing',
      dir: '/tmp/billing',
      interfaces: [{ ...base.interfaces[0]!, id: 'iface-2', name: 'Invoices', slug: 'Invoices' }],
      requests: [{ ...base.requests[0]!, id: 'req-2', interfaceId: 'iface-2', name: 'Invoice 1' }],
      environments: [{ id: 'env-2', name: 'Dev', slug: 'Dev', order: 0, endpoints: {}, properties: {}, disabled: [] }],
      keystores: [{ id: 'ks-2', name: 'billing', path: '/tmp/billing/b.p12', type: 'pkcs12' }],
    };
  }

  it("merges both projects into the flattened indexes and keeps each one's order", () => {
    applyProject();
    useProjectStore.getState().applySnapshot('proj-2', billing());
    const state = useProjectStore.getState();

    expect(Object.keys(state.projects).sort()).toEqual(['proj-1', 'proj-2']);
    expect(Object.keys(state.interfaces).sort()).toEqual(['iface-1', 'iface-2']);
    expect(Object.keys(state.requests).sort()).toEqual(['req-1', 'req-2']);
    // Ordered by project name, so the tree does not reshuffle with every snapshot.
    expect(state.order).toEqual([
      { projectId: 'proj-2', interfaceIds: ['iface-2'] },
      { projectId: 'proj-1', interfaceIds: ['iface-1'] },
    ]);
    expect(state.keystores).toEqual([
      { id: 'ks-2', name: 'billing', path: '/tmp/billing/b.p12', type: 'pkcs12', projectId: 'proj-2' },
    ]);
  });

  it('answers which project owns every kind of entity', () => {
    applyProject();
    useProjectStore.getState().applySnapshot('proj-2', billing());
    const { projectOf } = useProjectStore.getState();

    expect(projectOf).toMatchObject({
      'proj-1': 'proj-1',
      'iface-1': 'proj-1',
      'req-1': 'proj-1',
      'proj-2': 'proj-2',
      'iface-2': 'proj-2',
      'req-2': 'proj-2',
      'env-2': 'proj-2',
      'ks-2': 'proj-2',
    });
  });

  it('removing one project keeps the other intact', () => {
    applyProject();
    useProjectStore.getState().applySnapshot('proj-2', billing());
    useProjectStore.getState().applySnapshot('proj-1', null);
    const state = useProjectStore.getState();

    expect(Object.keys(state.projects)).toEqual(['proj-2']);
    expect(state.interfaces['iface-1']).toBeUndefined();
    expect(state.requests['req-1']).toBeUndefined();
    expect(state.projectOf['req-1']).toBeUndefined();
    expect(state.requests['req-2']?.name).toBe('Invoice 1');
    expect(state.order).toEqual([{ projectId: 'proj-2', interfaceIds: ['iface-2'] }]);
  });

  it('removing a project drops its save status and changed-on-disk paths', () => {
    applyProject();
    useProjectStore.getState().applySnapshot('proj-2', billing());
    useProjectStore.setState({
      saveStatus: { 'proj-1': 'saved', 'proj-2': 'error' },
      changedOnDisk: { 'proj-1': ['wirebench.yaml'], 'proj-2': [] },
    });

    useProjectStore.getState().applySnapshot('proj-1', null);

    expect(useProjectStore.getState().saveStatus).toEqual({ 'proj-2': 'error' });
    expect(useProjectStore.getState().changedOnDisk).toEqual({ 'proj-2': [] });
  });

  it('drops a mutation reply that lands after reset()', async () => {
    applyProject();
    type Reply = { ok: true; value: { project: ProjectWire } };
    let answer: ((reply: Reply) => void) | undefined;
    installWirebenchApi({
      project: {
        mutate: vi.fn(
          () =>
            new Promise<Reply>((resolve) => {
              answer = resolve;
            }),
        ),
      },
    });

    const inFlight = useProjectStore.getState().setProjectProperty('proj-1', 'host', 'x');
    useProjectStore.getState().reset();
    answer?.({ ok: true, value: { project: projectWire() } });
    await inFlight;

    expect(useProjectStore.getState().projects).toEqual({});
  });

  it('routes an entity-addressed action to the project that owns the entity', async () => {
    applyProject();
    useProjectStore.getState().applySnapshot('proj-2', billing());
    const mutate = vi.fn().mockResolvedValue({ ok: true, value: { project: billing(), createdRequestId: 'req-3' } });
    installWirebenchApi({ project: { mutate } });

    await useProjectStore.getState().cloneRequest('req-2');

    expect(mutate).toHaveBeenCalledWith({ projectId: 'proj-2', change: { kind: 'clone-request', requestId: 'req-2' } });
    // The reply replaced only that project; the other is untouched.
    expect(useProjectStore.getState().requests['req-1']).toBeDefined();
  });

  it('refuses an action addressed at an entity no open project holds', async () => {
    applyProject();
    await expect(useProjectStore.getState().cloneRequest('req-nope')).rejects.toThrow(/No open project holds/);
  });

  it("keeps changed-on-disk paths per project, so reloading one leaves the other's banner alone", async () => {
    applyProject();
    useProjectStore.getState().applySnapshot('proj-2', billing());
    const reload = vi.fn().mockResolvedValue({ ok: true, value: { project: projectWire() } });
    installWirebenchApi({ project: { reload } });
    useProjectStore.getState().noteChangedOnDisk('proj-1', ['wirebench.yaml']);
    useProjectStore.getState().noteChangedOnDisk('proj-2', ['wirebench.yaml']);

    await useProjectStore.getState().reloadProject('proj-1');

    expect(reload).toHaveBeenCalledWith({ projectId: 'proj-1' });
    expect(useProjectStore.getState().changedOnDisk).toEqual({ 'proj-1': [], 'proj-2': ['wirebench.yaml'] });
  });

  it('reset() empties everything', () => {
    applyProject();
    useProjectStore.getState().applySnapshot('proj-2', billing());
    useProjectStore.getState().noteChangedOnDisk('proj-2', ['wirebench.yaml']);

    useProjectStore.getState().reset();

    expect(useProjectStore.getState()).toMatchObject({
      projects: {},
      interfaces: {},
      requests: {},
      order: [],
      projectOf: {},
      keystores: [],
      saveStatus: {},
      changedOnDisk: {},
    });
  });
});
