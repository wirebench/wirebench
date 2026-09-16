import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useInterfaceEditorStore } from '../../src/renderer/features/interface-editor/interface-editor-state.js';
import { useDraftsStore } from '../../src/renderer/state/drafts.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { subscribeToWorkspace, useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { ProjectWire, WorkspaceProjectWire, WorkspaceSummaryWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { NO_REST, PROJECT_SETTINGS } from '../helpers/wire-defaults.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

const SUMMARY: WorkspaceSummaryWire = {
  id: 'w1',
  name: 'Workspace 1',
  dir: '/tmp/workspaces/w1',
  projectCount: 0,
  internalProjectCount: 0,
  createdAt: '2026-09-11T00:00:00.000Z',
};

const PROJECT: ProjectWire = {
  ...NO_REST,
  settings: PROJECT_SETTINGS,
  id: 'p1',
  name: 'Calculator',
  dir: '/tmp/workspaces/w1/projects/Calculator',
  dirty: false,
  interfaces: [],
  requests: [],
  properties: {},
  disabledProperties: [],
  environments: [],
  problems: [],
  keystores: [],
  wssOutgoing: [],
  wssIncoming: [],
};

/** The workspace's view of `PROJECT`, and a snapshot of it holding one request. */
const PROJECT_REF: WorkspaceProjectWire = {
  id: 'p1',
  name: 'Calculator',
  slug: 'calculator',
  source: 'internal',
  dir: '/tmp/workspaces/w1/projects/Calculator',
  status: 'ready',
};

const PROJECT_WITH_REQUEST: ProjectWire = {
  ...NO_REST,
  ...PROJECT,
  requests: [{ id: 'r1', name: 'Add', interfaceId: 'i1', operationName: 'Add', bindingName: 'b' } as never],
};

function resetStores(): void {
  useWorkspaceStore.setState({ workspace: null, workspaces: [], suggestions: [], status: 'idle', error: undefined });
  useDraftsStore.getState().reset();
  useProjectStore.getState().reset();
  useEditorsStore.getState().reset();
  useExchangesStore.getState().reset();
  useInterfaceEditorStore.getState().reset();
}

describe('useWorkspaceStore', () => {
  beforeEach(() => {
    resetStores();
    installWirebenchApi();
  });

  it('list fills the picker rows and the leftover-project suggestions', async () => {
    installWirebenchApi({
      workspace: {
        list: vi.fn().mockResolvedValue({
          ok: true,
          value: { workspaces: [SUMMARY], suggestions: ['/old/projects/calc'] },
        }),
      },
    });

    await useWorkspaceStore.getState().list();

    expect(useWorkspaceStore.getState()).toMatchObject({
      workspaces: [SUMMARY],
      suggestions: ['/old/projects/calc'],
      status: 'idle',
    });
  });

  it('list records the error rather than throwing', async () => {
    installWirebenchApi({
      workspace: {
        list: vi.fn().mockResolvedValue({ ok: false, error: { code: 'io', message: 'unreadable userData' } }),
      },
    });

    await useWorkspaceStore.getState().list();

    expect(useWorkspaceStore.getState().status).toBe('error');
    expect(useWorkspaceStore.getState().error?.message).toBe('unreadable userData');
  });

  it('create names a workspace, opens it, and refreshes the list', async () => {
    const workspace = workspaceWire({ name: 'Payments' });
    const create = vi.fn().mockResolvedValue({ ok: true, value: { workspace } });
    const list = vi.fn().mockResolvedValue({ ok: true, value: { workspaces: [{ ...SUMMARY, name: 'Payments' }] } });
    installWirebenchApi({ workspace: { create, list } });

    await useWorkspaceStore.getState().create('Payments');

    expect(create).toHaveBeenCalledWith({ name: 'Payments' });
    expect(useWorkspaceStore.getState().workspace).toEqual(workspace);
    expect(list).toHaveBeenCalled();
    expect(useWorkspaceStore.getState().workspaces.map((row) => row.name)).toEqual(['Payments']);
  });

  it('open mirrors the workspace it opened', async () => {
    const workspace = workspaceWire();
    const open = vi.fn().mockResolvedValue({ ok: true, value: { workspace } });
    installWirebenchApi({ workspace: { open } });

    await useWorkspaceStore.getState().open('w1');

    expect(open).toHaveBeenCalledWith({ workspaceId: 'w1' });
    expect(useWorkspaceStore.getState().workspace).toEqual(workspace);
  });

  it('a failed open throws, records the error, and leaves the picker up', async () => {
    installWirebenchApi({
      workspace: {
        open: vi.fn().mockResolvedValue({ ok: false, error: { code: 'workspace-not-found', message: 'gone' } }),
      },
    });

    await expect(useWorkspaceStore.getState().open('nope')).rejects.toThrow('gone');
    expect(useWorkspaceStore.getState().workspace).toBeNull();
    expect(useWorkspaceStore.getState().error?.code).toBe('workspace-not-found');
  });

  it("applySnapshot(null) resets every store keyed by the closed workspace's entities", () => {
    useWorkspaceStore.getState().applySnapshot(workspaceWire());
    useProjectStore.getState().applySnapshot('p1', PROJECT);
    useEditorsStore.getState().open({ id: 'request:r1', kind: 'request', title: 'Request 1', requestId: 'r1' });
    useExchangesStore.setState({ byRequest: { r1: { status: 'sending', sendId: 's1' } } });
    useInterfaceEditorStore.getState().setTab('i1', 'schema');

    useWorkspaceStore.getState().applySnapshot(null);

    expect(useWorkspaceStore.getState().workspace).toBeNull();
    expect(useProjectStore.getState().projects).toEqual({});
    expect(useEditorsStore.getState().tabs).toEqual([]);
    expect(useEditorsStore.getState().activeId).toBeUndefined();
    expect(useExchangesStore.getState().byRequest).toEqual({});
    expect(useInterfaceEditorStore.getState().tabs).toEqual({});
  });

  it('applySnapshot(workspace) leaves the other stores alone', () => {
    useProjectStore.getState().applySnapshot('p1', PROJECT);
    useWorkspaceStore.getState().applySnapshot(workspaceWire({ name: 'Renamed' }));
    expect(useProjectStore.getState().projects['p1']).toBeDefined();
  });

  it('pulls every ready project the mirror lacks when a workspace arrives', async () => {
    // A renderer that subscribes after the hosts came up (a reload, a reopened window) has
    // missed every `project.changed`; the workspace is its only cue to ask.
    const snapshot = vi.fn().mockResolvedValue({ ok: true, value: { project: PROJECT } });
    installWirebenchApi({ project: { snapshot } });

    useWorkspaceStore.getState().applySnapshot(
      workspaceWire({
        projects: [
          {
            id: 'p1',
            name: 'Calculator',
            slug: 'Calculator',
            source: 'internal',
            dir: '/w/p/Calculator',
            status: 'ready',
          },
          { id: 'p9', name: 'Gone', slug: 'Gone', source: 'linked', dir: '/elsewhere/Gone', status: 'missing' },
        ],
      }),
    );

    await vi.waitFor(() => {
      expect(useProjectStore.getState().projects['p1']).toEqual(PROJECT);
    });
    expect(useProjectStore.getState().order.map((entry) => entry.projectId)).toEqual(['p1']);
    // Only ready projects have a host to answer.
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledWith({ projectId: 'p1' });
  });

  it('does not pull a project the mirror already has', () => {
    const snapshot = vi.fn().mockResolvedValue({ ok: true, value: { project: PROJECT } });
    installWirebenchApi({ project: { snapshot } });
    useProjectStore.getState().applySnapshot('p1', PROJECT);

    useWorkspaceStore.getState().applySnapshot(
      workspaceWire({
        projects: [
          {
            id: 'p1',
            name: 'Calculator',
            slug: 'Calculator',
            source: 'internal',
            dir: '/w/p/Calculator',
            status: 'ready',
          },
        ],
      }),
    );

    expect(snapshot).not.toHaveBeenCalled();
  });

  it('drops a pulled snapshot that lands after the workspace closed', async () => {
    type Reply = { ok: true; value: { project: ProjectWire } };
    let answer: ((reply: Reply) => void) | undefined;
    const snapshot = vi.fn(
      () =>
        new Promise<Reply>((resolve) => {
          answer = resolve;
        }),
    );
    installWirebenchApi({ project: { snapshot } });
    useWorkspaceStore.getState().applySnapshot(
      workspaceWire({
        projects: [
          {
            id: 'p1',
            name: 'Calculator',
            slug: 'Calculator',
            source: 'internal',
            dir: '/w/p/Calculator',
            status: 'ready',
          },
        ],
      }),
    );

    useWorkspaceStore.getState().applySnapshot(null);
    answer?.({ ok: true, value: { project: PROJECT } });
    await Promise.resolve();
    await Promise.resolve();

    expect(useProjectStore.getState().projects).toEqual({});
  });

  it("hands the open workspace's unsaved drafts to main before switching, then forgets them", async () => {
    useWorkspaceStore.getState().applySnapshot(workspaceWire());
    useDraftsStore.getState().stageRequest('r1', { envelopeXml: '<unsaved/>' });
    const order: string[] = [];
    const stashDrafts = vi.fn().mockImplementation(() => {
      order.push('stash');
      return Promise.resolve({ ok: true, value: {} });
    });
    const open = vi.fn().mockImplementation(() => {
      order.push('open');
      return Promise.resolve({ ok: true, value: { workspace: { ...workspaceWire(), id: 'w2', name: 'Other' } } });
    });
    installWirebenchApi({ workspace: { stashDrafts, open } });

    await useWorkspaceStore.getState().open('w2');

    expect(stashDrafts).toHaveBeenCalledWith({
      workspaceId: 'w1',
      requests: { r1: { envelopeXml: '<unsaved/>' } },
      restRequests: {},
      grpcRequests: {},
    });
    expect(order).toEqual(['stash', 'open']);
    expect(useDraftsStore.getState().dirtyRequestIds()).toEqual([]);
  });

  it('hands drafts over before closing, too', async () => {
    useWorkspaceStore.getState().applySnapshot(workspaceWire());
    useDraftsStore.getState().stageRequest('r1', { name: 'Renamed' });
    const stashDrafts = vi.fn().mockResolvedValue({ ok: true, value: {} });
    installWirebenchApi({
      workspace: { stashDrafts, close: vi.fn().mockResolvedValue({ ok: true, value: { workspace: null } }) },
    });

    await useWorkspaceStore.getState().close();

    expect(stashDrafts).toHaveBeenCalledWith({
      workspaceId: 'w1',
      requests: { r1: { name: 'Renamed' } },
      restRequests: {},
      grpcRequests: {},
    });
    expect(useDraftsStore.getState().dirtyRequestIds()).toEqual([]);
  });

  it('close applies the empty snapshot, resetting the project mirror', async () => {
    useWorkspaceStore.getState().applySnapshot(workspaceWire());
    useProjectStore.getState().applySnapshot('p1', PROJECT);
    installWirebenchApi({ workspace: { close: vi.fn().mockResolvedValue({ ok: true, value: { workspace: null } }) } });

    await useWorkspaceStore.getState().close();

    expect(useWorkspaceStore.getState().workspace).toBeNull();
    expect(useProjectStore.getState().projects).toEqual({});
  });

  it('addProject returns the new project id and mirrors the workspace', async () => {
    const workspace = workspaceWire({
      projects: [
        { id: 'p2', name: 'Billing', slug: 'Billing', source: 'internal', dir: '/w/p/Billing', status: 'ready' },
      ],
    });
    const addProject = vi.fn().mockResolvedValue({ ok: true, value: { workspace, projectId: 'p2' } });
    installWirebenchApi({ workspace: { addProject } });

    await expect(useWorkspaceStore.getState().addProject('Billing')).resolves.toBe('p2');
    expect(useWorkspaceStore.getState().workspace?.projects.map((project) => project.id)).toEqual(['p2']);
  });

  it('a cancelled folder pick reports false and changes nothing', async () => {
    const workspace = workspaceWire();
    useWorkspaceStore.getState().applySnapshot(workspace);
    installWirebenchApi({
      workspace: { linkProject: vi.fn().mockResolvedValue({ ok: true, value: { workspace: null } }) },
    });

    await expect(useWorkspaceStore.getState().linkProject()).resolves.toBe(false);
    expect(useWorkspaceStore.getState().workspace).toBe(workspace);
  });

  it('setActiveEnvironment and mutate send their change and mirror the reply', async () => {
    const environment = { id: 'e1', name: 'dev', slug: 'dev', order: 0, properties: {}, endpoints: {}, disabled: [] };
    const setActiveEnvironment = vi.fn().mockResolvedValue({
      ok: true,
      value: { workspace: workspaceWire({ environments: [environment], activeEnvironmentId: 'e1' }) },
    });
    const mutate = vi.fn().mockResolvedValue({
      ok: true,
      value: { workspace: workspaceWire({ environments: [environment] }), createdEnvironmentId: 'e1' },
    });
    installWirebenchApi({ workspace: { setActiveEnvironment, mutate } });

    await expect(
      useWorkspaceStore.getState().mutate({ kind: 'add-workspace-environment', name: 'dev' }),
    ).resolves.toEqual({
      createdEnvironmentId: 'e1',
    });
    await useWorkspaceStore.getState().setActiveEnvironment('e1');

    expect(mutate).toHaveBeenCalledWith({ change: { kind: 'add-workspace-environment', name: 'dev' } });
    expect(setActiveEnvironment).toHaveBeenCalledWith({ environmentId: 'e1' });
    expect(useWorkspaceStore.getState().workspace?.activeEnvironmentId).toBe('e1');
  });

  it('setWorkspacePropertyEnabled sends the toggle through mutate', async () => {
    const mutate = vi.fn().mockResolvedValue({ ok: true, value: { workspace: workspaceWire() } });
    installWirebenchApi({ workspace: { mutate } });

    await useWorkspaceStore.getState().setWorkspacePropertyEnabled('host', false);

    expect(mutate).toHaveBeenCalledWith({
      change: { kind: 'set-workspace-property-enabled', name: 'host', enabled: false },
    });
  });

  it('updateEnvironment sends the patch through update-workspace-environment', async () => {
    const environment = { id: 'e1', name: 'dev', slug: 'dev', order: 0, properties: {}, endpoints: {}, disabled: [] };
    useWorkspaceStore.getState().applySnapshot(workspaceWire({ environments: [environment] }));
    const mutate = vi.fn().mockResolvedValue({
      ok: true,
      value: { workspace: workspaceWire({ environments: [{ ...environment, disabled: ['host'] }] }) },
    });
    installWirebenchApi({ workspace: { mutate } });

    await useWorkspaceStore.getState().updateEnvironment('e1', { disabled: ['host'] });

    expect(mutate).toHaveBeenCalledWith({
      change: { kind: 'update-workspace-environment', environmentId: 'e1', patch: { disabled: ['host'] } },
    });
    expect(useWorkspaceStore.getState().workspace?.environments[0]?.disabled).toEqual(['host']);
  });

  it('updateEnvironment does nothing when the environment has since been removed', async () => {
    useWorkspaceStore.getState().applySnapshot(workspaceWire({ environments: [] }));
    const mutate = vi.fn();
    installWirebenchApi({ workspace: { mutate } });

    await useWorkspaceStore.getState().updateEnvironment('gone', { disabled: ['host'] });

    expect(mutate).not.toHaveBeenCalled();
  });

  it('subscribeToWorkspace pulls the snapshot and follows workspace.changed', async () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    installWirebenchApi({
      workspace: { snapshot: vi.fn().mockResolvedValue({ ok: true, value: { workspace: workspaceWire() } }) },
      on: ((name: string, listener: (payload: unknown) => void) => {
        listeners.set(name, listener);
        return () => listeners.delete(name);
      }) as unknown as Window['wirebench']['on'],
    });

    const off = subscribeToWorkspace();
    await vi.waitFor(() => {
      expect(useWorkspaceStore.getState().workspace?.id).toBe('w1');
    });

    listeners.get('workspace.changed')?.({ workspace: null });
    expect(useWorkspaceStore.getState().workspace).toBeNull();

    off();
    expect(listeners.has('workspace.changed')).toBe(false);
  });
});

describe('useWorkspaceStore tab memory', () => {
  beforeEach(() => {
    resetStores();
    useUiStore.setState({ workspaces: {} });
    installWirebenchApi();
  });

  it("saves the outgoing workspace's tabs on a switch and restores them on the way back", async () => {
    const second = workspaceWire({ id: 'w2', name: 'Billing' });
    installWirebenchApi({
      workspace: {
        open: vi
          .fn()
          .mockResolvedValueOnce({ ok: true, value: { workspace: second } })
          .mockResolvedValueOnce({ ok: true, value: { workspace: workspaceWire({ projects: [PROJECT_REF] }) } }),
        list: vi.fn().mockResolvedValue({ ok: true, value: { workspaces: [] } }),
      },
      project: { snapshot: vi.fn().mockResolvedValue({ ok: true, value: { project: PROJECT_WITH_REQUEST } }) },
    });

    // Workspace 1 is open with one request tab.
    useWorkspaceStore.getState().applySnapshot(workspaceWire({ projects: [PROJECT_REF] }));
    await vi.waitFor(() => expect(useProjectStore.getState().projects['p1']).toBeDefined());
    useEditorsStore.getState().open({ id: 'request:r1', kind: 'request', title: 'Add', requestId: 'r1' });

    await useWorkspaceStore.getState().open('w2');

    expect(useUiStore.getState().workspaces['w1']?.tabs).toEqual([{ kind: 'request', id: 'r1' }]);
    // The other workspace starts on a clean editor area: those tabs named its projects' requests.
    expect(useEditorsStore.getState().tabs).toEqual([]);

    await useWorkspaceStore.getState().open('w1');

    await vi.waitFor(() => {
      expect(useEditorsStore.getState().tabs.map((tab) => tab.id)).toEqual(['request:r1']);
    });
    expect(useEditorsStore.getState().activeId).toBe('request:r1');
  });
});

/**
 * `workspace === null` is what makes the shell show the picker, so a reply that lands *after*
 * the workspace closed must never be applied: it would put the IDE back on screen over
 * projects whose hosts main has already stopped.
 */
describe('useWorkspaceStore stale replies', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ workspace: null, workspaces: [] });
  });
  afterEach(() => {
    useWorkspaceStore.setState({ workspace: null, workspaces: [] });
    vi.restoreAllMocks();
  });

  /** A promise the test resolves by hand, standing in for a reply still in flight. */
  function deferred(): { promise: Promise<unknown>; resolve: (value: unknown) => void } {
    let resolve: (value: unknown) => void = () => undefined;
    const promise = new Promise<unknown>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it.each([
    [
      'mutate',
      (): Promise<unknown> =>
        useWorkspaceStore.getState().mutate({ kind: 'set-workspace-property', name: 'a', value: 'b' }),
    ],
    ['setActiveEnvironment', (): Promise<unknown> => useWorkspaceStore.getState().setActiveEnvironment('e1')],
  ])('drops a %s reply that lands after the workspace closed', async (_name, start) => {
    const pending = deferred();
    installWirebenchApi({
      workspace: {
        mutate: vi.fn().mockReturnValue(pending.promise),
        setActiveEnvironment: vi.fn().mockReturnValue(pending.promise),
        close: vi.fn().mockResolvedValue({ ok: true, value: { workspace: null } }),
        list: vi.fn().mockResolvedValue({ ok: true, value: { workspaces: [] } }),
      },
    });
    useWorkspaceStore.getState().applySnapshot(workspaceWire());
    expect(useWorkspaceStore.getState().workspace).not.toBeNull();

    const inFlight = start();
    await useWorkspaceStore.getState().close();
    expect(useWorkspaceStore.getState().workspace).toBeNull();

    pending.resolve({ ok: true, value: { workspace: workspaceWire() } });
    await inFlight;

    expect(useWorkspaceStore.getState().workspace).toBeNull();
  });

  it('still applies a reply when nothing closed in the meantime', async () => {
    installWirebenchApi({
      workspace: {
        mutate: vi.fn().mockResolvedValue({ ok: true, value: { workspace: workspaceWire({ name: 'Renamed' }) } }),
      },
    });
    useWorkspaceStore.getState().applySnapshot(workspaceWire());

    await useWorkspaceStore.getState().mutate({ kind: 'set-workspace-property', name: 'a', value: 'b' });

    expect(useWorkspaceStore.getState().workspace?.name).toBe('Renamed');
  });
});
