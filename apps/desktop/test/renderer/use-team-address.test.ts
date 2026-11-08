import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useTeamAddress } from '../../src/renderer/features/team/settings/use-team-address.js';

describe('useTeamAddress', () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, '', '/');
  });

  it('writes the team page into the address while Team settings is open', () => {
    window.history.replaceState(null, '', '/?keep=1');
    renderHook(() => {
      useTeamAddress('T1', 'people');
    });
    expect(window.location.search).toBe('?keep=1&panel=team&team=T1&page=people');
  });

  it('takes the team page out of the address when Team settings closes', () => {
    window.history.replaceState(null, '', '/?keep=1');
    const { unmount } = renderHook(() => {
      useTeamAddress('T1', 'people');
    });
    unmount();
    // App settings or View profile from the account menu: a reload must not land back in Team settings.
    expect(window.location.search).toBe('?keep=1');
  });
});
