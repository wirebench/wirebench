import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ShareDialog } from '../../src/renderer/features/workspace/share-dialog.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { AccountWire, TeamWire, TeamWorkspaceWire } from '../../src/shared/wire-types.js';
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

const SERVER = 'https://wb.example.com';
const account = (url: string, signedOut = false): AccountWire => ({
  url,
  userId: 'u1',
  email: 'ada@example.com',
  displayName: 'Ada',
  deviceName: 'laptop',
  signedOut,
  addedAt: '2026-09-25T10:00:00.000Z',
});
const TEAM: TeamWire = {
  id: '01J8ZK6Q3V4W5X6Y7Z8A9B0C1T',
  name: 'Payments QA',
  myRole: 'member',
  createdAt: '2026-09-25T10:00:00.000Z',
};
const STAGING: TeamWorkspaceWire = {
  id: '01J8ZK6Q3V4W5X6Y7Z8A9B0C1S',
  name: 'Staging',
  teamId: TEAM.id,
  teamName: TEAM.name,
  defaultRole: 'viewer',
  myRole: 'editor',
  source: 'grant',
  createdAt: '2026-09-25T10:00:00.000Z',
};
const ok = <T,>(value: T) => vi.fn().mockResolvedValue({ ok: true, value });
const shared = () =>
  ok({
    workspace: workspaceWire({
      share: { kind: 'server', managed: true, server: { url: SERVER, workspaceId: STAGING.id, teamName: TEAM.name } },
    }),
  });

describe('ShareDialog → Wirebench Server (server-sync §3.4)', () => {
  beforeEach(() => {
    installWirebenchApi();
    useWorkspaceStore.setState({ workspace: workspaceWire() });
    useAccountStore.setState({ servers: [account(SERVER)], loaded: true });
    useUiStore.setState({ shareDialogOpen: false, signInDialog: { open: false, url: undefined } });
  });
  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspace: null });
    useAccountStore.setState({ servers: [], loaded: false });
    useUiStore.setState({ shareDialogOpen: false, signInDialog: { open: false, url: undefined } });
  });

  async function chooseServer(): Promise<void> {
    await openShareDialog();
    await userEvent.click(screen.getByTestId('share-kind-server'));
    await waitFor(() => expect(screen.getByTestId<HTMLSelectElement>('share-team').value).toBe(TEAM.id));
  }

  it('is offered only once an account is signed in, with a way to sign in', async () => {
    useAccountStore.setState({ servers: [account(SERVER, true)], loaded: true });
    await openShareDialog();

    expect(screen.getByTestId<HTMLInputElement>('share-kind-server').disabled).toBe(true);
    await userEvent.click(screen.getByTestId('share-server-sign-in'));

    expect(useUiStore.getState().signInDialog.open).toBe(true);
    expect(useUiStore.getState().shareDialogOpen).toBe(false);
  });

  it('shares into a new server workspace named after this one, Viewer by default of three roles', async () => {
    const list = ok({ teams: [TEAM], serverAdmin: false });
    const shareToServer = shared();
    installWirebenchApi({ team: { list }, workspace: { shareToServer } });
    await chooseServer();

    expect(list).toHaveBeenCalledWith({ url: SERVER });
    expect(screen.getByTestId<HTMLInputElement>('share-server-name').value).toBe('Workspace 1');
    const roles = screen.getByTestId<HTMLSelectElement>('share-default-role');
    expect(roles.value).toBe('viewer');
    expect(
      within(roles)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['No access', 'Viewer', 'Editor']);
    await userEvent.selectOptions(roles, 'editor');
    await userEvent.click(screen.getByTestId('share-confirm'));

    await waitFor(() =>
      expect(shareToServer).toHaveBeenCalledWith({
        url: SERVER,
        teamId: TEAM.id,
        teamName: TEAM.name,
        target: { kind: 'new', name: 'Workspace 1', defaultRole: 'editor' },
      }),
    );
    await waitFor(() => expect(useUiStore.getState().shareDialogOpen).toBe(false));
  });

  it('refuses an empty name before asking main', async () => {
    const shareToServer = shared();
    installWirebenchApi({ team: { list: ok({ teams: [TEAM], serverAdmin: false }) }, workspace: { shareToServer } });
    await chooseServer();

    await userEvent.clear(screen.getByTestId('share-server-name'));

    expect(screen.getByTestId('share-confirm').hasAttribute('disabled')).toBe(true);
    expect(shareToServer).not.toHaveBeenCalled();
  });

  it('shares into an existing empty workspace the caller can edit', async () => {
    const serverTargets = ok({ workspaces: [STAGING] });
    const shareToServer = shared();
    installWirebenchApi({
      team: { list: ok({ teams: [TEAM], serverAdmin: false }) },
      workspace: { serverTargets, shareToServer },
    });
    await chooseServer();

    await userEvent.click(screen.getByTestId('share-target-existing'));
    await waitFor(() => expect(screen.getByTestId<HTMLSelectElement>('share-existing').value).toBe(STAGING.id));
    expect(serverTargets).toHaveBeenCalledWith({ url: SERVER, teamId: TEAM.id });
    await userEvent.click(screen.getByTestId('share-confirm'));

    await waitFor(() =>
      expect(shareToServer).toHaveBeenCalledWith({
        url: SERVER,
        teamId: TEAM.id,
        teamName: TEAM.name,
        target: { kind: 'existing', workspaceId: STAGING.id },
      }),
    );
  });

  it('says so when the team has no empty workspace to share into', async () => {
    installWirebenchApi({
      team: { list: ok({ teams: [TEAM], serverAdmin: false }) },
      workspace: { serverTargets: ok({ workspaces: [] }) },
    });
    await chooseServer();

    await userEvent.click(screen.getByTestId('share-target-existing'));

    expect(await screen.findByTestId('share-existing-empty')).toBeTruthy();
    expect(screen.getByTestId('share-confirm').hasAttribute('disabled')).toBe(true);
  });

  it('with no team to choose, an existing target shows the team state rather than Loading… for ever', async () => {
    const serverTargets = ok({ workspaces: [] });
    installWirebenchApi({ team: { list: ok({ teams: [], serverAdmin: false }) }, workspace: { serverTargets } });
    await openShareDialog();
    await userEvent.click(screen.getByTestId('share-kind-server'));
    expect(await screen.findByTestId('share-team-none')).toBeTruthy();

    await userEvent.click(screen.getByTestId('share-target-existing'));

    expect(screen.getByTestId('workspace-share-dialog').textContent).not.toContain('Loading…');
    expect(serverTargets).not.toHaveBeenCalled();
    expect(screen.getByTestId('share-confirm').hasAttribute('disabled')).toBe(true);
  });

  it.each([
    [
      'teams-workspace-name-taken',
      'teams-workspace-name-taken',
      'A workspace with that name already exists in this team.',
    ],
    [
      'sync-reconnect-viewer',
      'You have viewer access to the server copy.',
      'You have viewer access to the server copy.',
    ],
  ])('shows a %s refusal in the dialog and stays open', async (code, message, shown) => {
    const shareToServer = vi.fn().mockResolvedValue({ ok: false, error: { code, message } });
    installWirebenchApi({ team: { list: ok({ teams: [TEAM], serverAdmin: false }) }, workspace: { shareToServer } });
    await chooseServer();

    await userEvent.click(screen.getByTestId('share-confirm'));

    expect((await screen.findByTestId('share-server-error')).textContent).toBe(shown);
    expect(useUiStore.getState().shareDialogOpen).toBe(true);
  });
});
