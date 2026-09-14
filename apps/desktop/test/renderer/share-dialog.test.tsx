import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ShareDialog } from '../../src/renderer/features/workspace/share-dialog.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

async function openShareDialog(): Promise<void> {
  render(<ShareDialog />);
  act(() => {
    useUiStore.getState().setShareDialogOpen(true);
  });
  await screen.findByTestId('workspace-share-dialog');
}

describe('ShareDialog', () => {
  beforeEach(() => {
    installWirebenchApi();
    useWorkspaceStore.setState({ workspace: workspaceWire() });
    useUiStore.setState({ shareDialogOpen: false });
  });
  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspace: null });
    useUiStore.setState({ shareDialogOpen: false });
  });

  it('is closed until something opens it', () => {
    render(<ShareDialog />);
    expect(screen.queryByTestId('workspace-share-dialog')).toBeNull();
  });

  it('submits a git share with the remote and branch', async () => {
    const share = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { workspace: workspaceWire({ share: { kind: 'git', managed: true } }) } });
    installWirebenchApi({ workspace: { share } });
    await openShareDialog();

    await userEvent.type(screen.getByTestId('share-remote'), 'git@x:y.git');
    await waitFor(() => expect(screen.getByTestId('share-confirm').hasAttribute('disabled')).toBe(false));
    await userEvent.click(screen.getByTestId('share-confirm'));

    await waitFor(() => expect(share).toHaveBeenCalledWith({ remote: 'git@x:y.git', branch: 'main' }));
    await waitFor(() => expect(useUiStore.getState().shareDialogOpen).toBe(false));
  });

  it('shares with no remote when the field is left empty', async () => {
    const share = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { workspace: workspaceWire({ share: { kind: 'git', managed: true } }) } });
    installWirebenchApi({ workspace: { share } });
    await openShareDialog();

    expect(screen.getByTestId('share-confirm').hasAttribute('disabled')).toBe(false);
    await userEvent.click(screen.getByTestId('share-confirm'));

    await waitFor(() => expect(share).toHaveBeenCalledWith({ remote: undefined, branch: 'main' }));
  });

  it('rejects an ext:: remote inline and refuses to submit', async () => {
    const share = vi.fn();
    installWirebenchApi({ workspace: { share } });
    await openShareDialog();

    await userEvent.type(screen.getByTestId('share-remote'), 'ext::x');

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByTestId('share-confirm').hasAttribute('disabled')).toBe(true);
    await userEvent.click(screen.getByTestId('share-confirm'));
    expect(share).not.toHaveBeenCalled();
  });

  it('shares to a folder when that mode is chosen', async () => {
    const shareToFolder = vi.fn().mockResolvedValue({
      ok: true,
      value: { workspace: workspaceWire({ share: { kind: 'folder', managed: false } }) },
    });
    installWirebenchApi({ workspace: { shareToFolder } });
    await openShareDialog();

    await userEvent.click(screen.getByTestId('share-kind-folder'));
    expect(screen.queryByTestId('share-remote')).toBeNull();
    await userEvent.click(screen.getByTestId('share-confirm'));

    await waitFor(() => expect(shareToFolder).toHaveBeenCalledTimes(1));
  });
});
