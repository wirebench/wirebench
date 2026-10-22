import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RemoveProjectDialog } from '../../src/renderer/features/workspace/remove-project-dialog.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { WorkspaceEnvironmentWire, WorkspaceProjectWire } from '../../src/shared/wire-base.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

function wireProject(patch: Partial<WorkspaceProjectWire> = {}): WorkspaceProjectWire {
  return {
    id: 'p1',
    name: 'Calculator',
    slug: 'Calculator',
    source: 'internal',
    dir: '/tmp/workspaces/w1/projects/Calculator',
    status: 'ready',
    ...patch,
  };
}

/** A workspace environment, scoped to `projects` when given (#468). */
function environment(id: string, name: string, order: number, projects?: string[]): WorkspaceEnvironmentWire {
  return {
    id,
    name,
    slug: id,
    order,
    endpoints: {},
    properties: {},
    disabled: [],
    ...(projects !== undefined ? { projects } : {}),
  };
}

/** Opens the dialog on `project` and returns the `workspace.removeProject` spy. */
function open(
  project: WorkspaceProjectWire,
  others: { readonly projects?: WorkspaceProjectWire[]; readonly environments?: WorkspaceEnvironmentWire[] } = {},
): ReturnType<typeof vi.fn> {
  const removeProject = vi.fn().mockResolvedValue({ ok: true, value: { workspace: workspaceWire() } });
  installWirebenchApi({ workspace: { removeProject } });
  useWorkspaceStore.setState({
    workspace: workspaceWire({
      projects: [project, ...(others.projects ?? [])],
      environments: others.environments ?? [],
    }),
  });
  useUiStore.getState().requestRemoveProject(project.id);
  render(<RemoveProjectDialog />);
  return removeProject;
}

describe('RemoveProjectDialog', () => {
  beforeEach(() => {
    useProjectStore.getState().reset();
    useUiStore.setState({ confirmRemoveProjectId: undefined });
  });

  afterEach(() => {
    cleanup();
    useUiStore.setState({ confirmRemoveProjectId: undefined });
    useWorkspaceStore.setState({ workspace: null });
  });

  it('offers to trash an internal project folder, off by default (#684)', async () => {
    const removeProject = open(wireProject());

    expect(screen.getByTestId('remove-project-dialog')).toBeTruthy();
    expect(screen.getByText(/“Calculator” is removed from this workspace\./)).toBeTruthy();
    const checkbox = screen.getByTestId<HTMLInputElement>('remove-project-delete-files');
    expect(checkbox.checked).toBe(false);

    fireEvent.click(screen.getByTestId('remove-project-confirm'));

    await waitFor(() => expect(removeProject).toHaveBeenCalled());
    expect(removeProject).toHaveBeenCalledWith({ projectId: 'p1', deleteFiles: false });
    expect(useUiStore.getState().confirmRemoveProjectId).toBeUndefined();
  });

  it('trashes the folder when the checkbox is ticked', async () => {
    const removeProject = open(wireProject());

    fireEvent.click(screen.getByTestId('remove-project-delete-files'));
    fireEvent.click(screen.getByTestId('remove-project-confirm'));

    await waitFor(() => expect(removeProject).toHaveBeenCalled());
    expect(removeProject).toHaveBeenCalledWith({ projectId: 'p1', deleteFiles: true });
  });

  it('starts unchecked again for the next project, after a tick on the previous one (#684)', () => {
    open(wireProject(), { projects: [wireProject({ id: 'p2', name: 'Crm', slug: 'Crm' })] });
    fireEvent.click(screen.getByTestId('remove-project-delete-files'));
    expect(screen.getByTestId<HTMLInputElement>('remove-project-delete-files').checked).toBe(true);

    act(() => useUiStore.getState().requestRemoveProject(undefined));
    act(() => useUiStore.getState().requestRemoveProject('p2'));
    expect(screen.getByTestId<HTMLInputElement>('remove-project-delete-files').checked).toBe(false);
  });

  it('says a linked folder is left alone, and offers no choice about it', async () => {
    const removeProject = open(wireProject({ id: 'p2', name: 'Billing', source: 'linked', dir: '/elsewhere/billing' }));

    expect(screen.getByText(/It is linked, so its folder is left exactly where it is\./)).toBeTruthy();
    expect(screen.queryByTestId('remove-project-delete-files')).toBeNull();

    fireEvent.click(screen.getByTestId('remove-project-confirm'));

    await waitFor(() => expect(removeProject).toHaveBeenCalled());
    expect(removeProject).toHaveBeenCalledWith({ projectId: 'p2', deleteFiles: false });
  });

  it('names the environments the removal leaves with no project (#468)', () => {
    open(wireProject(), {
      projects: [wireProject({ id: 'p2', name: 'Crm', slug: 'Crm' })],
      environments: [
        environment('e1', 'Dev', 0),
        environment('e2', 'Calculator sandbox', 2, ['p1']),
        environment('e3', 'Shared QA', 3, ['p1', 'p2']),
        environment('e4', 'Calculator mock', 1, ['p1']),
      ],
    });
    expect(screen.getByTestId('remove-project-orphaned-environments').textContent).toBe(
      '“Calculator mock” and “Calculator sandbox” will apply to no project. They are kept, shown as No project.',
    );
  });

  it('names one such environment in the singular', () => {
    open(wireProject({ source: 'linked', dir: '/elsewhere' }), {
      environments: [environment('e2', 'Calculator sandbox', 0, ['p1'])],
    });
    expect(screen.getByTestId('remove-project-orphaned-environments').textContent).toBe(
      '“Calculator sandbox” will apply to no project. It is kept, shown as No project.',
    );
  });

  it('says nothing about environments when none is left without a project', () => {
    open(wireProject(), { environments: [environment('e1', 'Dev', 0)] });
    expect(screen.queryByTestId('remove-project-orphaned-environments')).toBeNull();
  });
});
