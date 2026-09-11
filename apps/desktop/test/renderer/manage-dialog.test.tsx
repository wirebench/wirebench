import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateWorkspaceDialog } from '../../src/renderer/features/workspace/create-workspace-dialog.js';
import { WorkspaceManageDialog } from '../../src/renderer/features/workspace/manage-dialog.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { WorkspaceSummaryWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

const ROWS: readonly WorkspaceSummaryWire[] = [
  { id: 'w1', name: 'Workspace 1', dir: '/tmp/workspaces/w1', projectCount: 2, createdAt: '2026-09-11T00:00:00.000Z' },
  { id: 'w2', name: 'Billing', dir: '/tmp/workspaces/w2', projectCount: 0, createdAt: '2026-09-11T00:00:00.000Z' },
];

/** The dialog pulls the list whenever it opens, so every case stubs `workspace.list`. */
function listStub() {
  return { list: vi.fn().mockResolvedValue({ ok: true, value: { workspaces: ROWS } }) };
}

async function openManageDialog(): Promise<void> {
  render(<WorkspaceManageDialog />);
  act(() => {
    useUiStore.getState().setWorkspaceManageOpen(true);
  });
  await screen.findByTestId('workspace-manage-dialog');
}

describe('WorkspaceManageDialog', () => {
  beforeEach(() => {
    installWirebenchApi({ workspace: listStub() });
    useWorkspaceStore.setState({
      workspace: workspaceWire({
        projects: [
          { id: 'p1', name: 'Calculator', slug: 'calculator', source: 'internal', dir: '/a', status: 'ready' },
          { id: 'p2', name: 'Linked', slug: 'linked', source: 'linked', dir: '/b', status: 'ready' },
        ],
      }),
      workspaces: ROWS,
    });
    useUiStore.setState({ workspaceManageOpen: false });
  });
  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspace: null, workspaces: [] });
    useUiStore.setState({ workspaceManageOpen: false });
  });

  it('is closed until something opens it', () => {
    render(<WorkspaceManageDialog />);
    expect(screen.queryByTestId('workspace-manage-dialog')).toBeNull();
  });

  it('lists every workspace with an editable name', async () => {
    await openManageDialog();

    const fields = screen.getAllByTestId('workspace-rename-name');
    expect(fields.map((field) => (field as HTMLInputElement).value)).toEqual(['Workspace 1', 'Billing']);
    expect(screen.getAllByTestId('workspace-delete').length).toBe(2);
  });

  it('renames on Enter and on blur, and leaves an unchanged name alone', async () => {
    const rename = vi.fn().mockResolvedValue({ ok: true, value: { workspaces: ROWS } });
    installWirebenchApi({ workspace: { ...listStub(), rename } });
    await openManageDialog();

    const fields = screen.getAllByTestId('workspace-rename-name');
    const first = fields[0] ?? document.createElement('input');
    const second = fields[1] ?? document.createElement('input');
    await userEvent.clear(first);
    await userEvent.type(first, 'Renamed{Enter}');
    await waitFor(() => expect(rename).toHaveBeenCalledWith({ workspaceId: 'w1', name: 'Renamed' }));

    rename.mockClear();
    await userEvent.click(second);
    await userEvent.tab();
    expect(rename).not.toHaveBeenCalled();

    await userEvent.clear(second);
    await userEvent.type(second, 'Invoices');
    await userEvent.tab();
    await waitFor(() => expect(rename).toHaveBeenCalledWith({ workspaceId: 'w2', name: 'Invoices' }));
  });

  it('deletes only after a confirmation naming the internal project count', async () => {
    const remove = vi.fn().mockResolvedValue({ ok: true, value: { workspaces: [ROWS[1]] } });
    installWirebenchApi({ workspace: { ...listStub(), delete: remove } });
    await openManageDialog();

    await userEvent.click(screen.getAllByTestId('workspace-delete')[0] as HTMLElement);

    // Only one of the open workspace's two projects lives inside it; the linked one is not
    // the app's to delete, and the copy has to say so.
    expect(screen.getByText(/“Workspace 1” and the 1 project stored inside it go to the trash\./)).toBeTruthy();
    expect(screen.getByText(/Linked project folders are left where they are\./)).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('workspace-delete-confirm'));
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ workspaceId: 'w1' }));
  });

  it('closes itself when the workspace it deleted was the open one', async () => {
    installWirebenchApi({
      workspace: { ...listStub(), delete: vi.fn().mockResolvedValue({ ok: true, value: { workspaces: [] } }) },
    });
    await openManageDialog();

    await userEvent.click(screen.getAllByTestId('workspace-delete')[0] as HTMLElement);
    await userEvent.click(screen.getByTestId('workspace-delete-confirm'));

    await waitFor(() => expect(useUiStore.getState().workspaceManageOpen).toBe(false));
  });
});

describe('CreateWorkspaceDialog', () => {
  beforeEach(() => {
    installWirebenchApi();
    useUiStore.setState({ workspaceCreateOpen: false });
  });
  afterEach(() => {
    cleanup();
    useUiStore.setState({ workspaceCreateOpen: false });
  });

  it('creates a workspace by name and closes', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { workspace: workspaceWire({ id: 'w9', name: 'Billing' }) } });
    installWirebenchApi({
      workspace: { create, list: vi.fn().mockResolvedValue({ ok: true, value: { workspaces: [] } }) },
    });
    render(<CreateWorkspaceDialog />);
    act(() => {
      useUiStore.getState().setWorkspaceCreateOpen(true);
    });

    expect(screen.getByTestId('workspace-create').hasAttribute('disabled')).toBe(true);
    await userEvent.type(screen.getByTestId('workspace-create-name'), '  Billing  {Enter}');

    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: 'Billing' }));
    await waitFor(() => expect(useUiStore.getState().workspaceCreateOpen).toBe(false));
  });
});
