import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useInterfaceEditorStore } from '../../src/renderer/features/interface-editor/interface-editor-state.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { subscribeToWorkspace, useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { ProjectWire, WorkspaceSummaryWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { PROJECT_SETTINGS } from '../helpers/wire-defaults.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

const SUMMARY: WorkspaceSummaryWire = {
  id: 'w1',
  name: 'Workspace 1',
  dir: '/tmp/workspaces/w1',
  projectCount: 0,
  createdAt: '2026-09-11T00:00:00.000Z',
};

const PROJECT: ProjectWire = {
  settings: PROJECT_SETTINGS,
  id: 'p1',
  name: 'Calculator',
  dir: '/tmp/workspaces/w1/projects/Calculator',
  dirty: false,
  interfaces: [],
  requests: [],
  properties: {},
  environments: [],
  problems: [],
  keystores: [],
  wssOutgoing: [],
  wssIncoming: [],
};

function resetStores(): void {
  useWorkspaceStore.setState({ workspace: null, workspaces: [], suggestions: [], status: 'idle', error: undefined });
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
    const environment = { id: 'e1', name: 'dev', slug: 'dev', order: 0, properties: {}, endpoints: {} };
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
