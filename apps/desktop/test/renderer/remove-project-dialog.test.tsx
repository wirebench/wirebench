import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RemoveProjectDialog } from '../../src/renderer/features/workspace/remove-project-dialog.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { WorkspaceProjectWire } from '../../src/shared/wire-types.js';
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

/** Opens the dialog on `project` and returns the `workspace.removeProject` spy. */
function open(project: WorkspaceProjectWire): ReturnType<typeof vi.fn> {
  const removeProject = vi.fn().mockResolvedValue({ ok: true, value: { workspace: workspaceWire() } });
  installWirebenchApi({ workspace: { removeProject } });
  useWorkspaceStore.setState({ workspace: workspaceWire({ projects: [project] }) });
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

  it('offers to trash an internal project folder, on by default', async () => {
    const removeProject = open(wireProject());

    expect(screen.getByTestId('remove-project-dialog')).toBeTruthy();
    expect(screen.getByText(/“Calculator” is removed from this workspace\./)).toBeTruthy();
    const checkbox = screen.getByTestId<HTMLInputElement>('remove-project-delete-files');
    expect(checkbox.checked).toBe(true);

    fireEvent.click(screen.getByTestId('remove-project-confirm'));

    await waitFor(() => expect(removeProject).toHaveBeenCalled());
    expect(removeProject).toHaveBeenCalledWith({ projectId: 'p1', deleteFiles: true });
    expect(useUiStore.getState().confirmRemoveProjectId).toBeUndefined();
  });

  it('keeps the folder when the checkbox is cleared', async () => {
    const removeProject = open(wireProject());

    fireEvent.click(screen.getByTestId('remove-project-delete-files'));
    fireEvent.click(screen.getByTestId('remove-project-confirm'));

    await waitFor(() => expect(removeProject).toHaveBeenCalled());
    expect(removeProject).toHaveBeenCalledWith({ projectId: 'p1', deleteFiles: false });
  });

  it('says a linked folder is left alone, and offers no choice about it', async () => {
    const removeProject = open(wireProject({ id: 'p2', name: 'Billing', source: 'linked', dir: '/elsewhere/billing' }));

    expect(screen.getByText(/It is linked, so its folder is left exactly where it is\./)).toBeTruthy();
    expect(screen.queryByTestId('remove-project-delete-files')).toBeNull();

    fireEvent.click(screen.getByTestId('remove-project-confirm'));

    await waitFor(() => expect(removeProject).toHaveBeenCalled());
    expect(removeProject).toHaveBeenCalledWith({ projectId: 'p2', deleteFiles: false });
  });
});
