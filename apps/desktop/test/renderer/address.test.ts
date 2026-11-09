import { describe, expect, it } from 'vitest';
import { formatAddress, isNewPlace, parseAddress } from '../../src/renderer/features/address/address.js';

describe('the browser client’s address', () => {
  it('is / for the workspace list', () => {
    expect(formatAddress({})).toBe('/');
    expect(parseAddress('/', '')).toEqual({});
  });

  it('names the workspace and the tab in the path, the view in the query', () => {
    const address = {
      workspace: '01M6VC',
      tab: { kind: 'rest-request', id: 'r-1' },
      view: 'history',
      sidebarHidden: true,
      console: 'http-log',
      code: true,
      environmentPanel: 'projects' as const,
      hostDetails: true,
    };
    const url = formatAddress(address);
    expect(url).toBe(
      '/workspaces/01M6VC/rest-request/r-1?view=history&sidebar=off&console=http-log&code=on&env=projects&host=on',
    );
    const [path, query] = url.split('?');
    expect(parseAddress(path!, `?${query}`)).toEqual(address);
  });

  it('carries the settings links the desktop sends', () => {
    expect(parseAddress('/', '?panel=team&team=T1&page=people')).toEqual({
      settings: { area: 'team', team: 'T1', page: 'people' },
    });
    expect(parseAddress('/workspaces/W', '?panel=user&page=password&add=passkey')).toEqual({
      workspace: 'W',
      settings: { area: 'user', page: 'password' },
    });
    expect(formatAddress({ settings: { area: 'team', team: 'T1', page: 'people' } })).toBe(
      '/?panel=team&team=T1&page=people',
    );
  });

  it('keeps parameters it does not own, and the passkey prompt only in User settings', () => {
    expect(formatAddress({ workspace: 'W' }, '?keep=1&view=history&add=passkey')).toBe('/workspaces/W?keep=1');
    expect(formatAddress({ settings: { area: 'user', page: 'password' } }, '?add=passkey')).toBe(
      '/?panel=user&page=password&add=passkey',
    );
  });

  it('leaves out what does not fit its shape', () => {
    expect(parseAddress('/workspaces/%E0%A4%A/x', '?view=<script>&panel=nope&env=maybe')).toEqual({});
    expect(parseAddress('/elsewhere/W', '')).toEqual({});
    expect(parseAddress('/workspaces/W/request', '')).toEqual({ workspace: 'W' });
  });

  it('a workspace, tab, area or settings page is a new place; a panel is not', () => {
    const here = { workspace: 'W', tab: { kind: 'request', id: 'a' } };
    expect(isNewPlace(here, { ...here, console: 'problems', code: true })).toBe(false);
    expect(isNewPlace(here, { ...here, tab: { kind: 'request', id: 'b' } })).toBe(true);
    expect(isNewPlace(here, { ...here, view: 'history' })).toBe(true);
    expect(isNewPlace(here, { workspace: 'X' })).toBe(true);
    expect(isNewPlace(here, { ...here, settings: { area: 'app' } })).toBe(true);
    // A settings page settling on its page after an address that named none is the same place.
    expect(isNewPlace({ settings: { area: 'team' } }, { settings: { area: 'team', page: 'people', team: 'T' } })).toBe(
      false,
    );
    expect(
      isNewPlace({ settings: { area: 'team', page: 'people' } }, { settings: { area: 'team', page: 'workspaces' } }),
    ).toBe(true);
  });
});
