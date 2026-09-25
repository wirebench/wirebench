import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OpenTeamWorkspaceDialog } from '../../src/renderer/features/workspace/open-team-workspace-dialog.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { AccountWire, TeamWorkspaceWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast }));

const SERVER = 'https://wb.example.com';
const OTHER = 'https://other.example.com';
const account = (url: string, signedOut = false): AccountWire => ({
  url,
  userId: 'u1',
  email: 'ada@example.com',
  displayName: 'Ada',
  deviceName: 'laptop',
  signedOut,
  addedAt: '2026-09-25T10:00:00.000Z',
});
const teamWorkspace = (id: string, name: string, myRole: TeamWorkspaceWire['myRole']): TeamWorkspaceWire => ({
  id,
  name,
  teamId: '01J8ZK6Q3V4W5X6Y7Z8A9B0C1T',
  teamName: 'Payments QA',
  defaultRole: 'viewer',
  myRole,
  source: 'default',
  createdAt: '2026-09-25T10:00:00.000Z',
});
const INTEGRATION = teamWorkspace('01J8ZK6Q3V4W5X6Y7Z8A9B0C1A', 'Integration', 'viewer');
const STAGING = teamWorkspace('01J8ZK6Q3V4W5X6Y7Z8A9B0C1B', 'Staging', 'editor');
const ok = <T,>(value: T) => vi.fn().mockResolvedValue({ ok: true, value });

async function openDialog(): Promise<void> {
  render(<OpenTeamWorkspaceDialog />);
  act(() => {
    useUiStore.getState().setTeamWorkspaceDialogOpen(true);
  });
  await screen.findByTestId('open-team-workspace-dialog');
}

describe('OpenTeamWorkspaceDialog (server-sync §3.4)', () => {
  beforeEach(() => {
    installWirebenchApi();
    showToast.mockClear();
    useAccountStore.setState({ servers: [account(SERVER)], loaded: true });
    useWorkspaceStore.setState({ workspace: null, workspaces: [] });
    useUiStore.setState({ teamWorkspaceDialogOpen: false, signInDialog: { open: false, url: undefined } });
  });
  afterEach(() => {
    cleanup();
    useAccountStore.setState({ servers: [], loaded: false });
    useWorkspaceStore.setState({ workspace: null });
    useUiStore.setState({ teamWorkspaceDialogOpen: false, signInDialog: { open: false, url: undefined } });
  });

  it('is closed until something opens it', () => {
    render(<OpenTeamWorkspaceDialog />);
    expect(screen.queryByTestId('open-team-workspace-dialog')).toBeNull();
  });

  it('lists exactly what main returns — the non-empty workspaces — with the team and your role', async () => {
    const teamWorkspaces = ok({
      workspaces: [
        { url: SERVER, workspace: INTEGRATION },
        { url: SERVER, workspace: STAGING },
      ],
    });
    installWirebenchApi({ workspace: { teamWorkspaces } });
    await openDialog();

    const rows = await screen.findAllByTestId('team-workspace-row');
    expect(rows.map((row) => row.getAttribute('data-workspace-id'))).toEqual([INTEGRATION.id, STAGING.id]);
    expect(rows[0]?.textContent).toContain('Integration');
    expect(rows[0]?.textContent).toContain('Payments QA');
    expect(rows[0]?.textContent).toContain('Viewer');
    expect(rows[1]?.textContent).toContain('Editor');
    // One server: naming it on every row would say nothing.
    expect(rows[0]?.textContent).not.toContain('wb.example.com');
    expect(teamWorkspaces).toHaveBeenCalledTimes(1);
  });

  it('names the server on each row once rows come from several', async () => {
    useAccountStore.setState({ servers: [account(SERVER), account(OTHER)], loaded: true });
    installWirebenchApi({
      workspace: {
        teamWorkspaces: ok({
          workspaces: [
            { url: SERVER, workspace: INTEGRATION },
            { url: OTHER, workspace: STAGING },
          ],
        }),
      },
    });
    await openDialog();

    const rows = await screen.findAllByTestId('team-workspace-row');
    expect(rows[0]?.textContent).toContain('wb.example.com');
    expect(rows[1]?.textContent).toContain('other.example.com');
  });

  it('says so when no team workspace has anything in it yet', async () => {
    installWirebenchApi({ workspace: { teamWorkspaces: ok({ workspaces: [] }) } });
    await openDialog();

    expect(await screen.findByTestId('open-team-workspace-empty')).toBeTruthy();
    expect(screen.queryAllByTestId('team-workspace-row')).toHaveLength(0);
  });

  it('opens a row through workspace.joinFromServer, then closes', async () => {
    const joinFromServer = ok({ workspace: workspaceWire({ id: STAGING.id, name: 'Staging' }) });
    installWirebenchApi({
      workspace: { teamWorkspaces: ok({ workspaces: [{ url: SERVER, workspace: STAGING }] }), joinFromServer },
    });
    await openDialog();

    await userEvent.click(await screen.findByTestId('team-workspace-row'));

    await waitFor(() => expect(joinFromServer).toHaveBeenCalledWith({ url: SERVER, workspaceId: STAGING.id }));
    await waitFor(() => expect(useUiStore.getState().teamWorkspaceDialogOpen).toBe(false));
    expect(useWorkspaceStore.getState().workspace?.id).toBe(STAGING.id);
  });

  it('keeps focus on the chosen row while it opens, and a second click does nothing (Task 14 minor)', async () => {
    let answer!: (value: { ok: false; error: { code: string; message: string } }) => void;
    const joinFromServer = vi.fn(
      () =>
        new Promise<{ ok: false; error: { code: string; message: string } }>((resolve) => {
          answer = resolve;
        }),
    );
    installWirebenchApi({
      workspace: {
        teamWorkspaces: ok({
          workspaces: [
            { url: SERVER, workspace: INTEGRATION },
            { url: SERVER, workspace: STAGING },
          ],
        }),
        joinFromServer,
      },
    });
    await openDialog();
    const [row, other] = await screen.findAllByTestId('team-workspace-row');

    await userEvent.click(row!);

    await waitFor(() => expect(row!.textContent).toContain('Opening…'));
    expect(document.activeElement).toBe(row);
    expect(row!.getAttribute('aria-disabled')).toBe('true');
    expect(other!.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(other!);
    expect(joinFromServer).toHaveBeenCalledTimes(1);
    answer({ ok: false, error: { code: 'sync-offline', message: 'Offline.' } });
    expect(await screen.findByTestId('open-team-workspace-error')).toBeTruthy();
  });

  it('offers the copy already on this machine instead, without a toast', async () => {
    const joinFromServer = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: 'workspace-already-present',
        message: '"Staging" is already on this machine.',
        details: { workspaceId: 'w-existing' },
      },
    });
    const open = ok({ workspace: workspaceWire({ id: 'w-existing' }) });
    installWirebenchApi({
      workspace: { teamWorkspaces: ok({ workspaces: [{ url: SERVER, workspace: STAGING }] }), joinFromServer, open },
    });
    await openDialog();

    await userEvent.click(await screen.findByTestId('team-workspace-row'));
    expect((await screen.findByTestId('open-team-workspace-already-present')).textContent).toContain(
      '"Staging" is already on this machine.',
    );
    expect(showToast).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('open-team-workspace-open-existing'));

    await waitFor(() => expect(open).toHaveBeenCalledWith({ workspaceId: 'w-existing' }));
    await waitFor(() => expect(useUiStore.getState().teamWorkspaceDialogOpen).toBe(false));
  });

  it('shows a refusal in the dialog and stays open', async () => {
    const joinFromServer = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'sync-not-supported-by-server', message: 'This server is too old to sync workspaces' },
    });
    installWirebenchApi({
      workspace: { teamWorkspaces: ok({ workspaces: [{ url: SERVER, workspace: STAGING }] }), joinFromServer },
    });
    await openDialog();

    await userEvent.click(await screen.findByTestId('team-workspace-row'));

    expect((await screen.findByTestId('open-team-workspace-error')).textContent).toBe(
      'This server is too old to sync workspaces',
    );
    expect(useUiStore.getState().teamWorkspaceDialogOpen).toBe(true);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('asks to sign in first when no account is signed in, without asking main', async () => {
    const teamWorkspaces = vi.fn();
    installWirebenchApi({ workspace: { teamWorkspaces } });
    useAccountStore.setState({ servers: [account(SERVER, true)], loaded: true });
    await openDialog();

    await userEvent.click(screen.getByTestId('open-team-workspace-sign-in'));

    expect(useUiStore.getState().signInDialog).toEqual({ open: true, url: SERVER });
    expect(useUiStore.getState().teamWorkspaceDialogOpen).toBe(false);
    expect(teamWorkspaces).not.toHaveBeenCalled();
  });
});
