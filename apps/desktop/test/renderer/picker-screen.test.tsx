import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspacePicker } from '../../src/renderer/features/workspace/picker-screen.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { WorkspaceSummaryWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

// The picker is what the app shows before any workspace is open.

const ROWS: WorkspaceSummaryWire[] = [
  {
    id: 'w1',
    name: 'Payments',
    dir: '/user-data/workspaces/w1',
    projectCount: 2,
    internalProjectCount: 2,
    createdAt: '2026-09-01T00:00:00.000Z',
    lastOpenedAt: '2026-09-10T08:00:00.000Z',
  },
  {
    id: 'broken',
    name: 'broken',
    dir: '/user-data/workspaces/broken',
    projectCount: 0,
    internalProjectCount: 0,
    createdAt: '',
    unreadable: true,
  },
];

function listing(workspaces: readonly WorkspaceSummaryWire[]) {
  return vi.fn().mockResolvedValue({ ok: true, value: { workspaces } });
}

describe('WorkspacePicker', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      workspace: null,
      workspaces: [],
      suggestions: [],
      status: 'idle',
      error: undefined,
      lastError: undefined,
    });
  });
  afterEach(cleanup);

  it('lists the workspaces, disabling one whose manifest cannot be read', async () => {
    installWirebenchApi({ workspace: { list: listing(ROWS) } });
    render(<WorkspacePicker />);

    const rows = await screen.findAllByTestId('workspace-picker-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Payments');
    expect(rows[0]?.textContent).toContain('2 projects');
    expect(rows[0]?.hasAttribute('disabled')).toBe(false);
    expect(rows[1]?.hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('workspace-picker')).toBeTruthy();
  });

  it('says so when there are no workspaces yet', async () => {
    installWirebenchApi({ workspace: { list: listing([]) } });
    render(<WorkspacePicker />);

    expect(await screen.findByText('No workspaces yet.')).toBeTruthy();
  });

  it('opens the workspace a row names', async () => {
    const open = vi.fn().mockResolvedValue({ ok: true, value: { workspace: workspaceWire() } });
    installWirebenchApi({ workspace: { list: listing(ROWS), open } });
    render(<WorkspacePicker />);

    await userEvent.click((await screen.findAllByTestId('workspace-picker-row'))[0]!);

    await waitFor(() => expect(open).toHaveBeenCalledWith({ workspaceId: 'w1' }));
    expect(useWorkspaceStore.getState().workspace?.id).toBe('w1');
  });

  it('creates a workspace by name, which also opens it', async () => {
    const create = vi.fn().mockResolvedValue({ ok: true, value: { workspace: workspaceWire({ name: 'Orders' }) } });
    installWirebenchApi({ workspace: { list: listing([]), create } });
    render(<WorkspacePicker />);

    expect(screen.getByTestId('workspace-create').hasAttribute('disabled')).toBe(true);
    await userEvent.type(screen.getByTestId('workspace-create-name'), '  Orders  ');
    await userEvent.click(screen.getByTestId('workspace-create'));

    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: 'Orders' }));
    expect(useWorkspaceStore.getState().workspace?.name).toBe('Orders');
  });

  it('creates on Enter, too', async () => {
    const create = vi.fn().mockResolvedValue({ ok: true, value: { workspace: workspaceWire() } });
    installWirebenchApi({ workspace: { list: listing([]), create } });
    render(<WorkspacePicker />);

    await userEvent.type(screen.getByTestId('workspace-create-name'), 'Workspace 1{Enter}');

    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: 'Workspace 1' }));
  });

  it('shows why the list could not be read', async () => {
    installWirebenchApi({
      workspace: { list: vi.fn().mockResolvedValue({ ok: false, error: { code: 'io', message: 'userData is gone' } }) },
    });
    render(<WorkspacePicker />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('userData is gone');
  });

  it('offers Reveal on an unreadable row, asking main by id', async () => {
    const reveal = vi.fn().mockResolvedValue({ ok: true, value: {} });
    installWirebenchApi({ workspace: { list: listing(ROWS), reveal } });
    render(<WorkspacePicker />);

    await userEvent.click(await screen.findByRole('button', { name: 'Reveal the folder of broken' }));

    await waitFor(() => expect(reveal).toHaveBeenCalledWith({ workspaceId: 'broken' }));
    // Only the unreadable row has one.
    expect(screen.getAllByRole('button', { name: /^Reveal the folder/ })).toHaveLength(1);
  });

  it('shows why the last workspace would not reopen at launch', async () => {
    installWirebenchApi({
      workspace: {
        list: vi.fn().mockResolvedValue({
          ok: true,
          value: { workspaces: ROWS, lastError: 'workspace.yaml: unexpected end of the stream' },
        }),
      },
    });
    render(<WorkspacePicker />);

    expect((await screen.findByRole('alert')).textContent).toBe('workspace.yaml: unexpected end of the stream');
  });

  it('imports a project folder, which main turns into a workspace when none is open', async () => {
    const importProjectFolder = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { workspace: workspaceWire({ name: 'Calculator' }) } });
    installWirebenchApi({ workspace: { list: listing([]), importProjectFolder } });
    render(<WorkspacePicker />);

    await userEvent.click(screen.getByTestId('workspace-import-folder'));

    await waitFor(() => expect(importProjectFolder).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useWorkspaceStore.getState().workspace?.name).toBe('Calculator'));
  });

  it('lists leftover project folders as one-click imports, sent by position', async () => {
    const importSuggestion = vi.fn().mockResolvedValue({ ok: true, value: { workspace: workspaceWire() } });
    installWirebenchApi({
      workspace: {
        list: vi.fn().mockResolvedValue({
          ok: true,
          value: { workspaces: [], suggestions: ['/old/Calculator', '/old/Billing'] },
        }),
        importSuggestion,
      },
    });
    render(<WorkspacePicker />);

    await userEvent.click(await screen.findByTitle('/old/Billing'));

    await waitFor(() => expect(importSuggestion).toHaveBeenCalledWith({ index: 1 }));
  });
});
