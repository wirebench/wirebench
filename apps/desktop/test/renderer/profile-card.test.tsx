import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AccountPersonWire, AccountWire, TeamMemberWire, TeamWire } from '@wirebench/wire/wire-base';
import { MembersTab } from '../../src/renderer/features/team/members-tab.js';
import { PeoplePage } from '../../src/renderer/features/team/settings/people-page.js';
import { PERSON_GONE } from '../../src/renderer/features/team/settings/profile-card.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { useLicenseStore } from '../../src/renderer/state/license.js';
import { clearPersonImages } from '../../src/renderer/state/person-images.js';
import { useTeamStore } from '../../src/renderer/state/team.js';
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
const team: TeamWire = { id: 'T1', name: 'Payments QA', myRole: 'member', createdAt: '2026-09-25T10:00:00.000Z' };
const member = (userId: string, extra: Partial<TeamMemberWire> = {}): TeamMemberWire => ({
  userId,
  email: `${userId}@wb.test`,
  displayName: `${userId} person`,
  role: 'member',
  disabled: false,
  addedAt: '2026-09-25T10:00:00.000Z',
  ...extra,
});
const ada: AccountPersonWire = {
  id: 'ada',
  displayName: 'Ada Lovelace',
  email: 'ada@wb.test',
  username: 'ada',
  about: 'First line <b>not bold</b>\nSecond line',
  photo: { version: 'p1' },
  cover: { version: 'c1' },
};
const ok = <T,>(value: T) => vi.fn().mockResolvedValue({ ok: true, value });
const image = vi.fn(({ userId, kind, version }: { userId: string; kind: string; version: string }) =>
  Promise.resolve({ ok: true, value: { dataUrl: `data:image/webp;base64,${userId}-${kind}-${version}` } }),
);

async function open(person: ReturnType<typeof vi.fn> = ok(ada)) {
  const api = installWirebenchApi({
    team: {
      list: ok({ teams: [team], serverAdmin: false }),
      listWorkspaces: ok({ workspaces: [] }),
      members: ok({
        members: [
          member('me'),
          member('ada', {
            displayName: 'Ada Lovelace',
            role: 'admin',
            username: 'ada',
            photo: { version: 'p1' },
          }),
          member('bob'),
        ],
      }),
      invitations: ok({ invitations: [] }),
    },
    account: { image, person } as never,
  });
  await useTeamStore.getState().open(URL_);
  return api;
}

beforeEach(() => {
  clearPersonImages();
  image.mockClear();
  useTeamStore.getState().reset();
  useLicenseStore.getState().reset();
  useAccountStore.setState({ servers: [account], loaded: true });
});
afterEach(() => {
  cleanup();
});

describe('People rows (user profile spec §4)', () => {
  it('show the photo when set, else initials, and @username after the email', async () => {
    await open();
    render(<PeoplePage />);
    const row = await screen.findByTestId('member-row-ada');
    await waitFor(() => {
      expect(row.querySelector('img')?.getAttribute('src')).toBe('data:image/webp;base64,ada-photo-p1');
    });
    expect(row.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(row.textContent).toContain('ada@wb.test · @ada');
    const bob = screen.getByTestId('member-row-bob');
    expect(bob.querySelector('img')).toBeNull();
    expect(bob.querySelector('[data-avatar="initials"]')?.textContent).toBe('BP');
    expect(screen.queryByTestId('member-username-bob')).toBeNull();
  });

  it('the name opens the card: cover, photo, name, @username, about as text, email and role', async () => {
    const api = await open();
    render(<PeoplePage />);
    fireEvent.click(await screen.findByTestId('member-name-ada'));
    const card = await screen.findByTestId('profile-card');
    await waitFor(() => {
      expect(screen.getByTestId('profile-card-about')).toBeTruthy();
    });
    expect(api.account.person).toHaveBeenCalledWith({ url: URL_, userId: 'ada' });
    expect(screen.getByTestId('profile-card-name').textContent).toBe('Ada Lovelace');
    expect(screen.getByTestId('profile-card-username').textContent).toBe('@ada');
    expect(screen.getByTestId('profile-card-email').textContent).toBe('ada@wb.test');
    expect(screen.getByTestId('profile-card-role').textContent).toBe('Admin');
    // Plain text: the markup shows as typed, nothing is parsed, and the line break is kept by CSS.
    const about = screen.getByTestId('profile-card-about');
    expect(about.textContent).toBe('First line <b>not bold</b>\nSecond line');
    expect(about.querySelector('b')).toBeNull();
    expect(about.className).toContain('whitespace-pre-line');
    await waitFor(() => {
      expect(screen.getByTestId('profile-card-cover-image').getAttribute('src')).toBe(
        'data:image/webp;base64,ada-cover-c1',
      );
    });
    expect(card.querySelector('img[data-testid="profile-card-photo"]')).toBeTruthy();
    fireEvent.click(screen.getByTestId('profile-card-close'));
    await waitFor(() => {
      expect(screen.queryByTestId('profile-card')).toBeNull();
    });
  });

  it('the avatar opens the card too, and Escape closes it', async () => {
    await open();
    render(<PeoplePage />);
    fireEvent.click(await screen.findByTestId('member-avatar-ada'));
    expect(await screen.findByTestId('profile-card')).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId('profile-card'), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('profile-card')).toBeNull();
    });
  });

  it('says so when the person no longer shares a team (the server’s 404)', async () => {
    await open(
      vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'identity-not-found', message: 'Person was not found.', details: { status: 404 } },
      }),
    );
    render(<PeoplePage />);
    fireEvent.click(await screen.findByTestId('member-name-bob'));
    expect((await screen.findByTestId('profile-card-error')).textContent).toBe(PERSON_GONE);
    expect(PERSON_GONE).toBe('This person is no longer on your teams.');
    // The row's name stays as the card's title.
    expect(screen.getByTestId('profile-card-name').textContent).toBe('bob person');
    expect(screen.queryByTestId('profile-card-email')).toBeNull();
  });

  it('shows any other failure in the host’s words', async () => {
    await open(vi.fn().mockResolvedValue({ ok: false, error: { code: 'network', message: 'Offline.' } }));
    render(<PeoplePage />);
    fireEvent.click(await screen.findByTestId('member-name-bob'));
    expect((await screen.findByTestId('profile-card-error')).textContent).toBe('Offline.');
  });
});

describe('the Team dialog’s members tab (plan ruling 10)', () => {
  it('shows the avatar only, with no card', async () => {
    await open();
    render(<MembersTab />);
    const row = await screen.findByTestId('member-row-ada');
    await waitFor(() => {
      expect(row.querySelector('img')?.getAttribute('src')).toBe('data:image/webp;base64,ada-photo-p1');
    });
    expect(screen.queryByTestId('member-name-ada')).toBeNull();
    expect(screen.getByTestId('member-row-bob').querySelector('[data-avatar="initials"]')).toBeTruthy();
  });
});
