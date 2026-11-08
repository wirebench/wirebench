import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PeoplePage } from '../../src/renderer/features/team/settings/people-page.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { useLicenseStore } from '../../src/renderer/state/license.js';
import { useTeamStore } from '../../src/renderer/state/team.js';
import type { AccountWire, TeamInvitationWire, TeamMemberWire, TeamWire } from '@wirebench/wire/wire-base';
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
const team = (myRole: 'member' | 'admin'): TeamWire => ({
  id: 'T1',
  name: 'Payments QA',
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
const pending: TeamInvitationWire = {
  id: 'i1',
  email: 'new@wb.test',
  role: 'member',
  createdBy: 'me',
  createdAt: '2026-11-01T10:00:00.000Z',
  expiresAt: new Date(Date.now() + 3 * 86_400_000 - 60_000).toISOString(),
};
const created = (id: string, url: string) => ({
  invitation: { id, email: 'new@wb.test', role: 'member' as const, url, expiresAt: '2026-11-14T10:00:00.000Z' },
});
const ok = <T,>(value: T) => vi.fn().mockResolvedValue({ ok: true, value });
const refuse = (code: string, message: string) => vi.fn().mockResolvedValue({ ok: false, error: { code, message } });

async function open(
  myRole: 'member' | 'admin',
  overrides: Record<string, unknown> = {},
  { serverAdmin = false, extra = {} }: { serverAdmin?: boolean; extra?: Record<string, unknown> } = {},
) {
  const api = installWirebenchApi({
    team: {
      list: ok({ teams: [team(myRole)], serverAdmin }),
      listWorkspaces: ok({ workspaces: [] }),
      members: ok({ members: [member('me', myRole), member('bob', 'member')] }),
      invitations: ok({ invitations: [pending] }),
      ...overrides,
    },
    ...extra,
  });
  await useTeamStore.getState().open(URL_);
  render(<PeoplePage />);
  return api;
}

describe('People page (settings split spec §3.3)', () => {
  beforeEach(() => {
    useTeamStore.getState().reset();
    useLicenseStore.getState().reset();
    useAccountStore.setState({ servers: [account], loaded: true });
  });
  afterEach(() => {
    cleanup();
  });

  it('Add people adds an existing account as a member', async () => {
    const api = await open('admin', { addMember: ok({ member: member('carol', 'member') }) });
    fireEvent.click(screen.getByTestId('people-add'));
    const dialog = await screen.findByTestId('add-people-dialog');
    fireEvent.change(within(dialog).getByTestId('add-people-email'), { target: { value: ' carol@wb.test ' } });
    fireEvent.change(within(dialog).getByTestId('add-people-role'), { target: { value: 'admin' } });
    fireEvent.click(within(dialog).getByTestId('add-people-submit'));
    expect((await within(dialog).findByTestId('add-people-result')).textContent).toBe(
      'Added carol@wb.test to Payments QA.',
    );
    expect(api.team.addMember).toHaveBeenCalledWith({ url: URL_, teamId: 'T1', email: 'carol@wb.test', role: 'admin' });
    expect(api.team.invite).not.toHaveBeenCalled();
    expect(within(dialog).queryByTestId('add-people-link')).toBeNull();
  });

  it('Add people invites an unknown email and shows the link with Copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const api = await open('admin', {
      addMember: refuse('teams-user-unknown', 'No user has that email.'),
      invite: ok(created('i2', 'https://wb.test/invite/s3cr3t')),
    });
    fireEvent.click(screen.getByTestId('people-add'));
    const dialog = await screen.findByTestId('add-people-dialog');
    fireEvent.change(within(dialog).getByTestId('add-people-email'), { target: { value: 'new@wb.test' } });
    fireEvent.click(within(dialog).getByTestId('add-people-submit'));
    expect((await within(dialog).findByTestId('add-people-result')).textContent).toBe(
      'No account has that email yet, so this is an invitation. Send them this link; it is shown only now.',
    );
    expect(api.team.invite).toHaveBeenCalledWith({ url: URL_, teamId: 'T1', email: 'new@wb.test', role: 'member' });
    expect(within(dialog).getByTestId<HTMLInputElement>('add-people-link').value).toBe('https://wb.test/invite/s3cr3t');
    fireEvent.click(within(dialog).getByTestId('add-people-copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://wb.test/invite/s3cr3t'));
  });

  it('Add people shows any other refusal in the dialog', async () => {
    const api = await open('admin', { addMember: refuse('teams-seats-full', 'Every seat is taken.') });
    fireEvent.click(screen.getByTestId('people-add'));
    const dialog = await screen.findByTestId('add-people-dialog');
    fireEvent.change(within(dialog).getByTestId('add-people-email'), { target: { value: 'x@wb.test' } });
    fireEvent.click(within(dialog).getByTestId('add-people-submit'));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Every seat is taken.');
    expect(api.team.invite).not.toHaveBeenCalled();
  });

  it('New link renews and shows the new link once', async () => {
    const renewInvitation = ok(created('i3', 'https://wb.test/invite/fresh'));
    const api = await open('admin', { renewInvitation });
    const row = screen.getByTestId('invitation-row-i1');
    expect(row.textContent).toContain('new@wb.test');
    expect(row.textContent).toContain('Invited as Member · link expires in 3 days');
    fireEvent.click(within(row).getByTestId('invitation-renew-i1'));
    const dialog = await screen.findByTestId('add-people-dialog');
    await waitFor(() =>
      expect(within(dialog).getByTestId<HTMLInputElement>('add-people-link').value).toBe(
        'https://wb.test/invite/fresh',
      ),
    );
    expect(api.team.renewInvitation).toHaveBeenCalledWith({ url: URL_, teamId: 'T1', invitationId: 'i1' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('add-people-dialog')).toBeNull());
    expect(useTeamStore.getState().lastInvite).toBeUndefined();
  });

  it('Revoke removes the row', async () => {
    const invitations = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { invitations: [pending] } })
      .mockResolvedValue({ ok: true, value: { invitations: [] } });
    const api = await open('admin', { invitations, revokeInvitation: ok({ done: true }) });
    fireEvent.click(screen.getByTestId('invitation-revoke-i1'));
    await waitFor(() => expect(screen.queryByTestId('invitation-row-i1')).toBeNull());
    expect(api.team.revokeInvitation).toHaveBeenCalledWith({ url: URL_, teamId: 'T1', invitationId: 'i1' });
  });

  it('demoting the last admin shows the server’s message on the row', async () => {
    await open('admin', { setMemberRole: refuse('teams-last-admin', 'A team needs at least one admin.') });
    fireEvent.change(screen.getByTestId('member-role-me'), { target: { value: 'member' } });
    expect((await screen.findByTestId('member-row-error-me')).textContent).toBe('A team needs at least one admin.');
    expect(screen.queryByTestId('member-row-error-bob')).toBeNull();
  });

  it('Leave team asks first, then removes you', async () => {
    const api = await open('member', { removeMember: ok({ done: true }) });
    const mine = screen.getByTestId('member-row-me');
    expect(mine.textContent).toContain('· you');
    expect(within(screen.getByTestId('member-row-bob')).queryByTestId('member-leave')).toBeNull();
    fireEvent.click(within(mine).getByTestId('member-leave'));
    expect(api.team.removeMember).not.toHaveBeenCalled();
    expect(await screen.findByText('Leave Payments QA?')).toBeTruthy();
    fireEvent.click(screen.getByTestId('member-remove-confirm-ok'));
    await waitFor(() => expect(api.team.removeMember).toHaveBeenCalledWith({ url: URL_, teamId: 'T1', userId: 'me' }));
  });

  it('a member sees roles as text, no Add people and no Waiting filter', async () => {
    await open('member');
    expect(screen.queryByTestId('member-role-bob')).toBeNull();
    expect(screen.getByTestId('member-row-bob').textContent).toContain('Member');
    expect(screen.queryByTestId('people-add')).toBeNull();
    expect(screen.queryByTestId('people-filter-waiting')).toBeNull();
    expect(screen.getByTestId('people-filter-all').textContent).toContain('2');
    expect(screen.queryByTestId('member-remove-bob')).toBeNull();
    // The search narrows the list.
    fireEvent.change(screen.getByTestId('people-search'), { target: { value: 'BOB' } });
    expect(screen.queryByTestId('member-row-me')).toBeNull();
    expect(screen.getByTestId('member-row-bob')).toBeTruthy();
  });

  it('a server admin sees the seat line', async () => {
    const licenseState = { seats: { used: 4, limit: 10 } };
    await open('admin', {}, { serverAdmin: true, extra: { license: { get: ok(licenseState) } } });
    expect((await screen.findByTestId('people-seats')).textContent).toBe('4 of 10 seats in use on this server');
    cleanup();
    installWirebenchApi({ license: { get: ok({ seats: { used: 4, limit: null } }) } });
    render(<PeoplePage />);
    await waitFor(() => expect(screen.getByTestId('people-seats').textContent).toBe('4 seats in use on this server'));
  });

  it('a server admin sees who has two-step sign-in, and can reset it behind a confirm', async () => {
    const resetTwoFactor = ok({ done: true });
    const serverPeople = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          people: [
            { userId: 'me', password: true, twoFactor: false, disabled: false },
            { userId: 'bob', password: true, twoFactor: true, disabled: false },
          ],
        },
      })
      .mockResolvedValue({ ok: true, value: { people: [] } });
    await open('member', {}, { serverAdmin: true, extra: { account: { serverPeople, resetTwoFactor } } });
    expect((await screen.findByTestId('member-two-factor-bob')).textContent).toBe('2-step');
    expect(screen.queryByTestId('member-two-factor-me')).toBeNull();
    // Not a team admin: the menu holds the reset only.
    fireEvent.pointerDown(screen.getByTestId('member-menu-bob'), { button: 0, ctrlKey: false });
    expect(await screen.findByTestId('member-reset-two-factor-bob')).toBeTruthy();
    expect(screen.queryByTestId('member-remove-bob')).toBeNull();
    fireEvent.click(screen.getByTestId('member-reset-two-factor-bob'));
    fireEvent.click(await screen.findByTestId('member-reset-two-factor-confirm-ok'));
    await waitFor(() => expect(resetTwoFactor).toHaveBeenCalledWith({ url: URL_, userId: 'bob' }));
    await waitFor(() => expect(screen.queryByTestId('member-two-factor-bob')).toBeNull());
  });

  it('shows no two-step badge or reset to anyone but a server admin', async () => {
    const serverPeople = ok({ people: [{ userId: 'bob', password: true, twoFactor: true, disabled: false }] });
    await open('admin', {}, { extra: { account: { serverPeople } } });
    await screen.findByTestId('member-row-bob');
    expect(serverPeople).not.toHaveBeenCalled();
    expect(screen.queryByTestId('member-two-factor-bob')).toBeNull();
  });
});
