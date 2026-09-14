import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SyncPanel } from '../../src/renderer/features/sync/sync-panel.js';
import { useSyncStore } from '../../src/renderer/state/sync.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { workspaceWire } from '../helpers/workspace-wire.js';
import type { SyncStatusWire } from '../../src/shared/wire-types.js';

const STATUS: SyncStatusWire = {
  kind: 'git',
  gitAvailable: true,
  state: 'ahead',
  ahead: 1,
  behind: 0,
  uncommitted: 0,
  remote: 'https://example.test/repo.git',
  branch: 'main',
};

function openShared(): void {
  useWorkspaceStore.setState({ workspace: workspaceWire({ share: { kind: 'git', managed: true } }) });
  useSyncStore.setState({ status: STATUS, conflicts: [] });
}

describe('SyncPanel', () => {
  beforeEach(() => {
    useUiStore.setState({ syncPanelOpen: false, conflictResolverOpen: false });
  });
  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspace: null });
    useSyncStore.getState().reset();
    useUiStore.setState({ syncPanelOpen: false, conflictResolverOpen: false });
  });

  it('is closed until opened', () => {
    installWirebenchApi();
    openShared();
    render(<SyncPanel />);
    expect(screen.queryByTestId('sync-panel')).toBeNull();
  });

  it('has a title, and loads the log on open', async () => {
    const log = vi.fn().mockResolvedValue({
      ok: true,
      value: { entries: [{ id: 'c1', subject: 'Add request', author: 'Ada', at: '2026-09-14T11:00:00Z' }] },
    });
    installWirebenchApi({ sync: { log } });
    openShared();
    render(<SyncPanel />);

    useUiStore.getState().setSyncPanelOpen(true);

    await waitFor(() => expect(log).toHaveBeenCalledWith({ limit: 20 }));
    await waitFor(() => expect(screen.getAllByTestId('sync-log-row')).toHaveLength(1));
    expect(screen.getByTestId('sync-log-row').textContent).toContain('Add request');
    expect(screen.getByTestId('sync-log-row').textContent).toContain('Ada');
  });

  it('pulls via the store and disables the pull button while busy', async () => {
    let resolvePull: (value: { ok: true; value: SyncStatusWire }) => void = () => undefined;
    const pull = vi.fn(
      () =>
        new Promise<{ ok: true; value: SyncStatusWire }>((resolve) => {
          resolvePull = resolve;
        }),
    );
    installWirebenchApi({ sync: { pull } });
    openShared();
    render(<SyncPanel />);
    useUiStore.getState().setSyncPanelOpen(true);

    const pullButton = await screen.findByTestId('sync-pull');
    await userEvent.click(pullButton);

    expect(pull).toHaveBeenCalled();
    expect(pullButton.hasAttribute('disabled')).toBe(true);

    resolvePull({ ok: true, value: STATUS });
    await waitFor(() => expect(pullButton.hasAttribute('disabled')).toBe(false));
  });

  it('hides the commit button and message input while commit-on-save is on, shows it once off', async () => {
    installWirebenchApi();
    openShared();
    render(<SyncPanel />);
    useUiStore.getState().setSyncPanelOpen(true);

    const commitOnSave = await screen.findByLabelText('Commit on save');
    expect(screen.queryByTestId('sync-commit')).toBeNull();
    expect(screen.queryByTestId('sync-commit-message')).toBeNull();

    await userEvent.click(commitOnSave);

    expect(screen.getByTestId('sync-commit')).toBeTruthy();
    expect(screen.getByTestId('sync-commit-message')).toBeTruthy();
  });

  it('commits without a message when the field is left empty', async () => {
    const commit = vi.fn().mockResolvedValue({ ok: true, value: STATUS });
    installWirebenchApi({ sync: { commit } });
    openShared();
    render(<SyncPanel />);
    useUiStore.getState().setSyncPanelOpen(true);

    await userEvent.click(await screen.findByLabelText('Commit on save'));
    await userEvent.click(screen.getByTestId('sync-commit'));

    await waitFor(() => expect(commit).toHaveBeenCalledWith({ message: undefined }));
  });

  it('calls updateSettings when Push on save is toggled off', async () => {
    const updateSettings = vi.fn().mockResolvedValue({ ok: true, value: STATUS });
    installWirebenchApi({ sync: { updateSettings } });
    openShared();
    render(<SyncPanel />);
    useUiStore.getState().setSyncPanelOpen(true);

    await userEvent.click(await screen.findByLabelText('Push on save'));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ pushOnSave: false }));
  });

  it('initialises the settings controls from the persisted workspace.share, not from a default', async () => {
    installWirebenchApi();
    useWorkspaceStore.setState({
      workspace: workspaceWire({
        share: { kind: 'git', managed: true, autoFetchSeconds: 120, commitOnSave: true, pushOnSave: false },
      }),
    });
    useSyncStore.setState({ status: STATUS, conflicts: [] });
    render(<SyncPanel />);
    useUiStore.getState().setSyncPanelOpen(true);

    const autoFetch = await screen.findByLabelText<HTMLInputElement>('Auto-fetch every N seconds');
    const pushOnSave = await screen.findByLabelText<HTMLInputElement>('Push on save');
    expect(autoFetch.value).toBe('120');
    expect(pushOnSave.checked).toBe(false);
    // commit-on-save persisted true → the commit UI stays hidden.
    expect(screen.queryByTestId('sync-commit')).toBeNull();
  });

  it('re-syncs the settings controls when the store gets a new workspace snapshot', async () => {
    installWirebenchApi();
    openShared();
    render(<SyncPanel />);
    useUiStore.getState().setSyncPanelOpen(true);

    const autoFetch = await screen.findByLabelText<HTMLInputElement>('Auto-fetch every N seconds');
    expect(autoFetch.value).toBe('60');

    useWorkspaceStore.setState({
      workspace: workspaceWire({ share: { kind: 'git', managed: true, autoFetchSeconds: 45 } }),
    });

    await waitFor(() => expect(autoFetch.value).toBe('45'));
  });

  it('does not double-submit a commit while another sync action is busy', async () => {
    let resolvePull: (value: { ok: true; value: SyncStatusWire }) => void = () => undefined;
    const pull = vi.fn(
      () =>
        new Promise<{ ok: true; value: SyncStatusWire }>((resolve) => {
          resolvePull = resolve;
        }),
    );
    const commit = vi.fn().mockResolvedValue({ ok: true, value: STATUS });
    installWirebenchApi({ sync: { pull, commit } });
    openShared();
    render(<SyncPanel />);
    useUiStore.getState().setSyncPanelOpen(true);

    await userEvent.click(await screen.findByLabelText('Commit on save'));
    const pullButton = screen.getByTestId('sync-pull');
    await userEvent.click(pullButton);
    expect(pull).toHaveBeenCalled();

    const messageField = screen.getByTestId('sync-commit-message');
    expect(messageField.hasAttribute('disabled')).toBe(true);
    fireEvent.keyDown(messageField, { key: 'Enter' });
    expect(commit).not.toHaveBeenCalled();

    resolvePull({ ok: true, value: STATUS });
    await waitFor(() => expect(pullButton.hasAttribute('disabled')).toBe(false));
  });

  it('rejects an out-of-range auto-fetch value inline, without calling the channel', async () => {
    const updateSettings = vi.fn().mockResolvedValue({ ok: true, value: STATUS });
    installWirebenchApi({ sync: { updateSettings } });
    openShared();
    render(<SyncPanel />);
    useUiStore.getState().setSyncPanelOpen(true);

    const field = await screen.findByLabelText('Auto-fetch every N seconds');
    await userEvent.clear(field);
    await userEvent.type(field, '999999{Enter}');

    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('lists conflicts and opens the resolver from a row', async () => {
    installWirebenchApi();
    openShared();
    useSyncStore.setState({
      conflicts: [{ path: 'projects/a/request.yaml', entity: { kind: 'request', name: 'Get' } }],
    });
    render(<SyncPanel />);
    useUiStore.getState().setSyncPanelOpen(true);

    await waitFor(() => expect(screen.getByTestId('sync-panel-conflicts')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: /resolve/i }));

    expect(useUiStore.getState().conflictResolverOpen).toBe(true);
  });

  it('reveals the tree and confirms before stopping sharing', async () => {
    const revealTree = vi.fn().mockResolvedValue({ ok: true, value: {} });
    const stopSharing = vi.fn().mockResolvedValue({ ok: true, value: { workspace: workspaceWire() } });
    installWirebenchApi({ sync: { revealTree }, workspace: { stopSharing } });
    openShared();
    render(<SyncPanel />);
    useUiStore.getState().setSyncPanelOpen(true);

    await userEvent.click(await screen.findByTestId('sync-reveal-tree'));
    await waitFor(() => expect(revealTree).toHaveBeenCalled());

    await userEvent.click(screen.getByTestId('sync-stop-sharing'));
    await userEvent.click(screen.getByTestId('sync-stop-sharing-confirm'));
    await waitFor(() => expect(stopSharing).toHaveBeenCalled());
  });
});
