import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SyncPanel } from '../../src/renderer/features/sync/sync-panel.js';
import { VIEWER_PUSH_REASON } from '../../src/renderer/features/sync/sync-codes.js';
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

  it('does not clobber a committed-but-not-yet-persisted draft when an unrelated workspace snapshot arrives', async () => {
    const updateSettings = vi.fn().mockResolvedValue({ ok: true, value: STATUS });
    installWirebenchApi({ sync: { updateSettings } });
    openShared();
    render(<SyncPanel />);
    useUiStore.getState().setSyncPanelOpen(true);

    const autoFetch = await screen.findByLabelText<HTMLInputElement>('Auto-fetch every N seconds');
    // Commits locally (the panel's own `autoFetchSeconds` state becomes '90') without the mocked
    // channel ever reflecting it back onto `workspace.share` — exactly the window between a user
    // submitting a change and main's `workspace.changed` echo arriving.
    await userEvent.clear(autoFetch);
    await userEvent.type(autoFetch, '90{Enter}');
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ autoFetchSeconds: 90 }));
    expect(autoFetch.value).toBe('90');

    // A rename (or any other workspace-level mutation) broadcasts a fresh `workspace.changed`
    // with a brand-new `share` object carrying the exact same (still-default) settings — this
    // must not be mistaken for a settings change and must not overwrite the just-committed value.
    // `act` flushes the resulting render and its effects synchronously, so the assertion below
    // observes the settled state rather than racing a pending update.
    act(() => {
      useWorkspaceStore.setState({
        workspace: workspaceWire({ name: 'Renamed', share: { kind: 'git', managed: true } }),
      });
    });

    expect(autoFetch.value).toBe('90');
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

const SERVER_URL = 'https://wb.example.com';

const SERVER_STATUS: SyncStatusWire = {
  kind: 'server',
  gitAvailable: true,
  state: 'clean',
  ahead: 0,
  behind: 0,
  uncommitted: 0,
  remote: SERVER_URL,
  branch: 'main',
  role: 'editor',
};

function openServerShared(status: Partial<SyncStatusWire> = {}): void {
  useWorkspaceStore.setState({
    workspace: workspaceWire({
      share: {
        kind: 'server',
        managed: true,
        server: { url: SERVER_URL, workspaceId: '01J8ZK6Q3V4W5X6Y7Z8A9B0C1D', teamName: 'Payments QA' },
      },
    }),
  });
  useSyncStore.setState({ status: { ...SERVER_STATUS, ...status }, conflicts: [] });
}

async function showPanel(): Promise<HTMLElement> {
  render(<SyncPanel />);
  act(() => {
    useUiStore.getState().setSyncPanelOpen(true);
  });
  return screen.findByTestId('sync-panel');
}

describe('SyncPanel on a Wirebench Server share (server-sync §3.4, §5.4)', () => {
  beforeEach(() => {
    installWirebenchApi();
    useUiStore.setState({
      syncPanelOpen: false,
      signInDialog: { open: false, url: undefined },
      teamWorkspaceDialogOpen: false,
    });
  });
  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspace: null });
    useSyncStore.getState().reset();
    useUiStore.setState({
      syncPanelOpen: false,
      signInDialog: { open: false, url: undefined },
      teamWorkspaceDialogOpen: false,
    });
  });

  it('shows the server and the team instead of the remote and the branch', async () => {
    openServerShared();
    const panel = await showPanel();

    expect(panel.textContent).toContain(`${SERVER_URL} · Payments QA`);
    expect(screen.getByLabelText<HTMLInputElement>('Server').value).toBe(SERVER_URL);
    expect(screen.getByLabelText<HTMLInputElement>('Server').readOnly).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Team').value).toBe('Payments QA');
    expect(screen.queryByLabelText('Remote')).toBeNull();
    expect(screen.queryByLabelText('Branch')).toBeNull();
    expect(screen.queryByTestId('sync-viewer-note')).toBeNull();
    expect(screen.getByTestId('sync-push').hasAttribute('disabled')).toBe(false);
  });

  it('a viewer cannot push: Push and Push on save are disabled with the reason; pull and commit on save stay', async () => {
    openServerShared({ role: 'viewer', state: 'ahead', ahead: 1 });
    await showPanel();

    const push = screen.getByTestId('sync-push');
    expect(push.hasAttribute('disabled')).toBe(true);
    expect(push.getAttribute('title')).toBe(VIEWER_PUSH_REASON);
    expect(screen.getByTestId('sync-viewer-note').textContent).toBe(VIEWER_PUSH_REASON);
    expect(screen.getByLabelText<HTMLInputElement>('Push on save').disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Commit on save').disabled).toBe(false);
    expect(screen.getByTestId('sync-pull').hasAttribute('disabled')).toBe(false);
  });

  it.each(['sync-signed-out', 'sync-account-disabled', 'sync-access-removed'])(
    '%s shows why, and Sign in opens the Sign in dialog for that server',
    async (code) => {
      openServerShared({ state: 'error', error: { code, message: `Because ${code}.` } });
      await showPanel();

      expect((await screen.findByTestId('sync-error-notice')).textContent).toContain(`Because ${code}.`);
      await userEvent.click(screen.getByTestId('sync-sign-in'));

      expect(useUiStore.getState().signInDialog).toEqual({ open: true, url: SERVER_URL });
      expect(useUiStore.getState().syncPanelOpen).toBe(false);
    },
  );

  it.each(['sync-history-mismatch', 'sync-state-corrupt'])(
    '%s offers Stop sharing… first, which asks to confirm, and Open a team workspace… second (I4)',
    async (code) => {
      openServerShared({ state: 'error', error: { code, message: 'Stop sharing, then share it again.' } });
      await showPanel();

      const notice = await screen.findByTestId('sync-error-notice');
      const buttons = [...notice.querySelectorAll('button')].map((button) => button.getAttribute('data-testid'));
      expect(buttons).toEqual(['sync-notice-stop-sharing', 'sync-open-team-workspace']);

      await userEvent.click(screen.getByTestId('sync-notice-stop-sharing'));
      expect(await screen.findByTestId('sync-stop-sharing-confirm')).toBeTruthy();
    },
  );

  it('a history mismatch still offers Open a team workspace…', async () => {
    openServerShared({ state: 'error', error: { code: 'sync-history-mismatch', message: 'Open it again.' } });
    await showPanel();

    await userEvent.click(await screen.findByTestId('sync-open-team-workspace'));

    expect(useUiStore.getState().teamWorkspaceDialogOpen).toBe(true);
    expect(useUiStore.getState().syncPanelOpen).toBe(false);
  });

  it('a refused push keeps the state and shows the reason, with nothing to click', async () => {
    openServerShared({ state: 'ahead', ahead: 1, error: { code: 'sync-forbidden', message: 'Viewers cannot push.' } });
    await showPanel();

    const notice = await screen.findByTestId('sync-error-notice');
    expect(notice.textContent).toContain('Viewers cannot push.');
    expect(screen.queryByTestId('sync-sign-in')).toBeNull();
    expect(screen.queryByTestId('sync-open-team-workspace')).toBeNull();
  });

  it('shows no notice for a git failure, as before', async () => {
    useWorkspaceStore.setState({ workspace: workspaceWire({ share: { kind: 'git', managed: true } }) });
    useSyncStore.setState({
      status: { ...STATUS, state: 'error', error: { code: 'git-auth-failed', message: 'x' } },
      conflicts: [],
    });
    await showPanel();

    expect(screen.queryByTestId('sync-error-notice')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Remote').value).toBe('');
  });
});
