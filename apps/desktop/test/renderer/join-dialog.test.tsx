import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JoinDialog } from '../../src/renderer/features/workspace/join-dialog.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

async function openJoinDialog(): Promise<void> {
  render(<JoinDialog />);
  act(() => {
    useUiStore.getState().setJoinDialogOpen(true);
  });
  await screen.findByTestId('workspace-join-dialog');
}

describe('JoinDialog', () => {
  beforeEach(() => {
    installWirebenchApi();
    useWorkspaceStore.setState({ workspace: null });
    useUiStore.setState({ joinDialogOpen: false });
  });
  afterEach(() => {
    cleanup();
    useUiStore.setState({ joinDialogOpen: false });
  });

  it('is closed until something opens it', () => {
    render(<JoinDialog />);
    expect(screen.queryByTestId('workspace-join-dialog')).toBeNull();
  });

  it('disables Join until a remote is entered, then calls join with the branch', async () => {
    const join = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { workspace: workspaceWire({ share: { kind: 'git', managed: true } }) } });
    installWirebenchApi({
      workspace: { join, list: vi.fn().mockResolvedValue({ ok: true, value: { workspaces: [] } }) },
    });
    await openJoinDialog();

    expect(screen.getByTestId('join-confirm').hasAttribute('disabled')).toBe(true);
    await userEvent.type(screen.getByTestId('join-remote'), 'git@x:y.git');
    await waitFor(() => expect(screen.getByTestId('join-confirm').hasAttribute('disabled')).toBe(false));
    await userEvent.click(screen.getByTestId('join-confirm'));

    await waitFor(() => expect(join).toHaveBeenCalledWith({ remote: 'git@x:y.git', branch: 'main' }));
    await waitFor(() => expect(useUiStore.getState().joinDialogOpen).toBe(false));
  });

  it('shows Cloning… while the join is in flight', async () => {
    let resolve!: (value: unknown) => void;
    const join = vi.fn().mockReturnValue(new Promise((r) => (resolve = r)));
    installWirebenchApi({ workspace: { join } });
    await openJoinDialog();

    await userEvent.type(screen.getByTestId('join-remote'), 'git@x:y.git');
    await userEvent.click(screen.getByTestId('join-confirm'));

    await waitFor(() => expect(screen.getByTestId('join-confirm').textContent).toBe('Cloning…'));
    resolve({ ok: true, value: { workspace: workspaceWire() } });
  });

  it('rejects a disallowed remote inline', async () => {
    installWirebenchApi();
    await openJoinDialog();

    await userEvent.type(screen.getByTestId('join-remote'), 'ext::x');

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByTestId('join-confirm').hasAttribute('disabled')).toBe(true);
  });

  it('joins from an existing folder via the secondary button', async () => {
    const joinFromFolder = vi.fn().mockResolvedValue({
      ok: true,
      value: { workspace: workspaceWire({ share: { kind: 'folder', managed: false } }) },
    });
    installWirebenchApi({
      workspace: { joinFromFolder, list: vi.fn().mockResolvedValue({ ok: true, value: { workspaces: [] } }) },
    });
    await openJoinDialog();

    await userEvent.click(screen.getByTestId('join-from-folder'));

    await waitFor(() => expect(joinFromFolder).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useUiStore.getState().joinDialogOpen).toBe(false));
  });
});
