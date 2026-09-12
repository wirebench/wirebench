import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectRowActions } from '../../src/renderer/features/explorer/project-actions.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { ProjectWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { PROJECT_SETTINGS } from '../helpers/wire-defaults.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

const project: ProjectWire = {
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

describe('projectRowActions', () => {
  beforeEach(() => {
    useProjectStore.getState().reset();
    useProjectStore.getState().applySnapshot(project.id, project);
    useUiStore.setState({ selection: undefined });
  });

  afterEach(() => {
    useWorkspaceStore.setState({ workspace: null });
  });

  it('opens a linked project environment matched to the active workspace environment', async () => {
    useProjectStore.getState().applySnapshot('p1', {
      ...project,
      environments: [
        { id: 'pe-uat', name: 'uat', slug: 'uat', order: 0, properties: {}, endpoints: {} },
        { id: 'pe-dev', name: 'dev', slug: 'dev', order: 1, properties: {}, endpoints: {} },
      ],
    });
    useWorkspaceStore.setState({
      workspace: workspaceWire({
        environments: [{ id: 'we-dev', name: 'dev', slug: 'dev', order: 0, properties: {}, endpoints: {} }],
        activeEnvironmentId: 'we-dev',
      }),
    });

    await projectRowActions.projectEnvironments('p1');

    // The slug the workspace's active environment carries — not simply the project's first.
    expect(useEditorsStore.getState().tabs.map((tab) => tab.id)).toEqual(['env:pe-dev']);
    useEditorsStore.setState({ tabs: [], activeId: undefined });
  });

  it('creates an environment for a linked project that has none, then opens it', async () => {
    const addEnvironment = vi.fn().mockResolvedValue('pe-new');
    useProjectStore.setState({ addEnvironment });
    useWorkspaceStore.setState({
      workspace: workspaceWire({
        environments: [{ id: 'we-dev', name: 'dev', slug: 'dev', order: 0, properties: {}, endpoints: {} }],
        activeEnvironmentId: 'we-dev',
      }),
    });

    await projectRowActions.projectEnvironments('p1');

    // Named after the active workspace environment, so the slugs line up and the project's own
    // values win over the workspace's, as the engine resolves them.
    expect(addEnvironment).toHaveBeenCalledWith('p1', 'dev');
    useEditorsStore.setState({ tabs: [], activeId: undefined });
  });

  it('commits an inline rename through project.mutate', async () => {
    const mutate = vi.fn().mockResolvedValue({ ok: true, value: { project: { ...project, name: 'Billing' } } });
    installWirebenchApi({ project: { mutate } });

    projectRowActions.commitRename('p1', '  Billing  ');

    await vi.waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(mutate).toHaveBeenCalledWith({ projectId: 'p1', change: { kind: 'rename-project', name: 'Billing' } });
  });

  it('leaves an unchanged or empty name alone', () => {
    const mutate = vi.fn();
    installWirebenchApi({ project: { mutate } });

    projectRowActions.commitRename('p1', 'Calculator');
    projectRowActions.commitRename('p1', '   ');

    expect(mutate).not.toHaveBeenCalled();
  });

  it('reveals a project by id, never by path', async () => {
    const revealProject = vi.fn().mockResolvedValue({ ok: true, value: {} });
    installWirebenchApi({ workspace: { revealProject } });

    projectRowActions.reveal('p1');

    await vi.waitFor(() => expect(revealProject).toHaveBeenCalled());
    expect(revealProject).toHaveBeenCalledWith({ projectId: 'p1' });
  });

  it('locates a missing project through main’s own folder dialog', async () => {
    const locateProject = vi.fn().mockResolvedValue({ ok: true, value: { workspace: workspaceWire() } });
    installWirebenchApi({ workspace: { locateProject } });

    projectRowActions.locate('p1');

    await vi.waitFor(() => expect(locateProject).toHaveBeenCalled());
    expect(locateProject).toHaveBeenCalledWith({ projectId: 'p1' });
  });

  it('shows a project’s settings in the details panel, on the selected project', () => {
    projectRowActions.settings('p1');

    expect(useUiStore.getState().selection).toEqual({ kind: 'project', id: 'p1' });
    expect(useUiStore.getState().details).toMatchObject({ visible: true, tab: 'selection' });
  });
});
