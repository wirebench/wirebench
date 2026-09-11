import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NewProjectDialog } from '../../src/renderer/features/workspace/new-project-dialog.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

describe('NewProjectDialog', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ workspace: workspaceWire() });
    useUiStore.setState({ newProjectDialogOpen: false, selection: undefined });
  });
  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspace: null });
    useUiStore.setState({ newProjectDialogOpen: false, selection: undefined });
  });

  it('is closed until something opens it', () => {
    installWirebenchApi();
    render(<NewProjectDialog />);
    expect(screen.queryByTestId('new-project-dialog')).toBeNull();
  });

  it('creates a project by name, selects it and closes', async () => {
    const addProject = vi.fn().mockResolvedValue({ ok: true, value: { workspace: workspaceWire(), projectId: 'p9' } });
    installWirebenchApi({ workspace: { addProject } });
    render(<NewProjectDialog />);
    act(() => {
      useUiStore.getState().setNewProjectDialogOpen(true);
    });

    expect(screen.getByTestId('new-project-create').hasAttribute('disabled')).toBe(true);
    await userEvent.type(screen.getByTestId('new-project-name'), '  Billing  ');
    await userEvent.click(screen.getByTestId('new-project-create'));

    await waitFor(() => expect(addProject).toHaveBeenCalledWith({ name: 'Billing' }));
    await waitFor(() => expect(useUiStore.getState().newProjectDialogOpen).toBe(false));
    expect(useUiStore.getState().selection).toEqual({ kind: 'project', id: 'p9' });
  });

  it('creates on Enter, and stays open when main refuses', async () => {
    const addProject = vi.fn().mockResolvedValue({ ok: false, error: { code: 'io', message: 'disk full' } });
    installWirebenchApi({ workspace: { addProject } });
    render(<NewProjectDialog />);
    act(() => {
      useUiStore.getState().setNewProjectDialogOpen(true);
    });

    await userEvent.type(screen.getByTestId('new-project-name'), 'Billing{Enter}');

    await waitFor(() => expect(addProject).toHaveBeenCalledWith({ name: 'Billing' }));
    expect(useUiStore.getState().newProjectDialogOpen).toBe(true);
    expect(screen.getByTestId('new-project-dialog')).toBeTruthy();
  });
});
