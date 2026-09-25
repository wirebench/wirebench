import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { TeamDialog } from '../../src/renderer/features/team/team-dialog.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { useTeamStore } from '../../src/renderer/state/team.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import type { AccountWire, TeamMemberWire, TeamWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const URL_ = 'https://wb.test';
const account: AccountWire = {
  url: URL_,
  userId: 'me',
  email: 'me@wb.test',
  displayName: 'Me',
  deviceName: 'd',
  signedOut: false,
  addedAt: '2026-09-24T12:00:00.000Z',
};
const team = (myRole: 'member' | 'admin', id = 'T1', name = 'Payments QA'): TeamWire => ({
  id,
  name,
  myRole,
  createdAt: '2026-09-25T10:00:00.000Z',
});
const member = (userId: string, role: 'member' | 'admin'): TeamMemberWire => ({
  userId,
  email: `${userId}@wb.test`,
  displayName: userId,
  role,
  disabled: false,
  addedAt: '2026-09-25T10:00:00.000Z',
});
const ok = <T,>(value: T) => vi.fn().mockResolvedValue({ ok: true, value });
const unauthenticated = () =>
  vi.fn().mockResolvedValue({ ok: false, error: { code: 'identity-unauthenticated', message: 'x' } });

function install(myRole: 'member' | 'admin', overrides: Record<string, unknown> = {}, serverAdmin = false) {
  return installWirebenchApi({
    team: {
      list: ok({ teams: [team(myRole)], serverAdmin }),
      listWorkspaces: ok({ workspaces: [] }),
      members: ok({ members: [member('me', myRole), member('bob', 'member')] }),
      invitations: ok({ invitations: [] }),
      invite: ok({
        invitation: {
          id: 'i1',
          email: 'new@wb.test',
          role: 'member',
          url: 'https://wb.test/invite/s3cr3t',
          expiresAt: '2026-10-02T10:00:00.000Z',
        },
      }),
      ...overrides,
    },
  });
}

describe('TeamDialog (teams-access §3.5)', () => {
  beforeEach(() => {
    useTeamStore.getState().reset();
    useAccountStore.setState({ servers: [account], loaded: true });
    useUiStore.setState({ teamDialog: { open: true, url: URL_ }, signInDialog: { open: false, url: undefined } });
  });
  afterEach(() => {
    cleanup();
  });

  it('a member sees the team read-only: no role selects, no add, no invitations tab, Leave on their own row', async () => {
    install('member');
    render(<TeamDialog />);
    await screen.findByTestId('member-row-bob');
    expect(screen.getByTestId<HTMLInputElement>('team-name').readOnly).toBe(true);
    expect(screen.queryByTestId('member-role-bob')).toBeNull();
    expect(screen.queryByTestId('member-add')).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Invitations' })).toBeNull();
    expect(screen.queryByTestId('member-remove-bob')).toBeNull();
    expect(screen.getByTestId('member-remove-me').textContent).toBe('Leave');
    expect(screen.queryByTestId('team-new')).toBeNull();
    expect(screen.queryByTestId('team-delete')).toBeNull();
  });

  it('a team admin changes a role and invites; the link is shown once', async () => {
    const setMemberRole = ok({ member: member('bob', 'admin') });
    install('admin', { setMemberRole });
    render(<TeamDialog />);
    const select = await screen.findByTestId<HTMLSelectElement>('member-role-bob');
    fireEvent.change(select, { target: { value: 'admin' } });
    await vi.waitFor(() =>
      expect(setMemberRole).toHaveBeenCalledWith({ url: URL_, teamId: 'T1', userId: 'bob', role: 'admin' }),
    );

    fireEvent.click(screen.getByTestId('member-invite'));
    const dialog = await screen.findByTestId('invite-dialog');
    fireEvent.change(within(dialog).getByTestId('invite-email'), { target: { value: 'new@wb.test' } });
    fireEvent.click(within(dialog).getByTestId('invite-submit'));
    const link = await screen.findByTestId<HTMLInputElement>('invite-link');
    expect(link.value).toBe('https://wb.test/invite/s3cr3t');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await vi.waitFor(() => expect(screen.queryByTestId('invite-link')).toBeNull());
    expect(useTeamStore.getState().lastInvite).toBeUndefined();
  });

  it('a server admin can create a team and sees Delete team', async () => {
    const created = team('admin', 'T2', 'New');
    const list = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { teams: [team('admin')], serverAdmin: true } })
      .mockResolvedValue({ ok: true, value: { teams: [team('admin'), created], serverAdmin: true } });
    const create = ok({ team: created });
    install('admin', { list, create }, true);
    render(<TeamDialog />);
    fireEvent.click(await screen.findByTestId('team-new'));
    fireEvent.change(screen.getByTestId('team-new-name'), { target: { value: 'New' } });
    fireEvent.click(screen.getByTestId('team-new-submit'));
    await vi.waitFor(() => expect(create).toHaveBeenCalledWith({ url: URL_, name: 'New' }));
    await vi.waitFor(() => expect(screen.getByTestId<HTMLInputElement>('team-name').value).toBe('New'));
    expect(screen.getByTestId('team-delete')).toBeTruthy();
  });

  it('a signed-out server shows Sign in again, which hands over to the sign-in dialog', async () => {
    installWirebenchApi({ team: { list: unauthenticated(), listWorkspaces: unauthenticated() } });
    render(<TeamDialog />);
    fireEvent.click(await screen.findByTestId('team-sign-in-again'));
    expect(useUiStore.getState().signInDialog).toEqual({ open: true, url: URL_ });
    expect(useUiStore.getState().teamDialog.open).toBe(false);
  });
});
