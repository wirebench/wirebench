import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MoveProjectDialog } from '../../src/renderer/features/explorer/move-project-dialog.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { WorkspaceSummaryWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

const ROWS: readonly WorkspaceSummaryWire[] = [
  { id: 'w1', name: 'Open workspace', dir: '/tmp/w1', projectCount: 1, internalProjectCount: 1, createdAt: '' },
  { id: 'w2', name: 'Billing', dir: '/tmp/w2', projectCount: 0, internalProjectCount: 0, createdAt: '' },
  {
    id: 'w3',
    name: 'Broken',
    dir: '/tmp/w3',
    projectCount: 0,
    internalProjectCount: 0,
    createdAt: '',
    unreadable: true,
  },
];

describe('MoveProjectDialog', () => {
  beforeEach(() => {
    installWirebenchApi();
    useWorkspaceStore.setState({
      workspace: workspaceWire({
        id: 'w1',
        projects: [
          { id: 'p1', name: 'Calculator', slug: 'calculator', source: 'internal', dir: '/a', status: 'ready' },
        ],
      }),
      workspaces: ROWS,
    });
    useUiStore.setState({ moveProjectDialog: null });
  });
  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspace: null, workspaces: [] });
    useUiStore.setState({ moveProjectDialog: null });
  });

  it('is closed until something opens it', () => {
    render(<MoveProjectDialog />);
    expect(screen.queryByTestId('move-project-dialog')).toBeNull();
  });

  it('lists only other, readable workspaces as targets', async () => {
    render(<MoveProjectDialog />);
    act(() => {
      useUiStore.getState().setMoveProjectDialog('p1');
    });
    await screen.findByTestId('move-project-dialog');

    const options = screen.getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['Billing']);
  });

  it('moves the project to the chosen workspace after confirming', async () => {
    const moveToWorkspace = vi.fn().mockResolvedValue({ ok: true, value: { workspace: workspaceWire({ id: 'w1' }) } });
    installWirebenchApi({ project: { moveToWorkspace } });
    render(<MoveProjectDialog />);
    act(() => {
      useUiStore.getState().setMoveProjectDialog('p1');
    });
    await screen.findByTestId('move-project-dialog');

    await userEvent.click(screen.getByTestId('move-project-submit'));
    expect(screen.getByText(/moves to Billing; its files here go to the trash\./)).toBeTruthy();
    expect(moveToWorkspace).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('move-project-confirm'));

    await waitFor(() => expect(moveToWorkspace).toHaveBeenCalledWith({ projectId: 'p1', workspaceId: 'w2' }));
    await waitFor(() => expect(useUiStore.getState().moveProjectDialog).toBe(null));
  });
});
