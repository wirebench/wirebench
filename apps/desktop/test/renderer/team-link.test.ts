import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { readTeamDeepLink, takeTeamDeepLink, teamPageUrl } from '../../src/renderer/features/team/team-link.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import type { AccountWire } from '@wirebench/wire/wire-base';

const account = (url: string, signedOut = false): AccountWire => ({
  url,
  userId: 'u',
  email: `a@${new URL(url).host}`,
  displayName: 'A',
  deviceName: 'd',
  signedOut,
  addedAt: '2026-09-24T12:00:00.000Z',
});
describe('team links (team management in the browser §2)', () => {
  let open: MockInstance<Window['open']>;
  beforeEach(() => {
    useUiStore.setState({ teamDialog: { open: false, url: undefined } });
    useAccountStore.setState({ servers: [account('https://wb.test')], loaded: true });
    open = vi.spyOn(window, 'open').mockReturnValue(null);
  });
  afterEach(() => {
    open.mockRestore();
    window.history.replaceState(null, '', '/');
  });

  it('builds the team page URL on the server root, with the team or workspace', () => {
    expect(teamPageUrl('https://wb.test/')).toBe('https://wb.test/?panel=team');
    expect(teamPageUrl('https://acme.app.test', { workspaceId: 'W1' })).toBe(
      'https://acme.app.test/?panel=team&workspace=W1',
    );
    expect(teamPageUrl('https://wb.test', { teamId: 'T1' })).toBe('https://wb.test/?panel=team&team=T1');
  });

  it('reads the deep link, ignoring other pages and ids that are not ids', () => {
    expect(readTeamDeepLink('')).toBeUndefined();
    expect(readTeamDeepLink('?panel=other&team=T1')).toBeUndefined();
    expect(readTeamDeepLink('?panel=team')).toEqual({});
    expect(readTeamDeepLink('?panel=team&team=01JABC&workspace=W_1-2')).toEqual({
      teamId: '01JABC',
      workspaceId: 'W_1-2',
    });
    expect(readTeamDeepLink('?panel=team&team=%3Cscript%3E&workspace=')).toEqual({});
    expect(readTeamDeepLink(`?panel=team&team=${'a'.repeat(65)}`)).toEqual({});
  });

  it('takes the deep link once: opens the dialog on it and leaves the rest of the address alone', () => {
    window.history.replaceState(null, '', '/workspaces/x?panel=team&workspace=W1&keep=1#h');
    expect(takeTeamDeepLink()).toBe(true);
    expect(useUiStore.getState().teamDialog).toEqual({ open: true, url: undefined, target: { workspaceId: 'W1' } });
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      '/workspaces/x?keep=1#h',
    );
    useUiStore.setState({ teamDialog: { open: false, url: undefined } });
    expect(takeTeamDeepLink()).toBe(false);
    expect(useUiStore.getState().teamDialog.open).toBe(false);
  });
});
