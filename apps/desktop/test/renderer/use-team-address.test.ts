import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useSettingsPlaceStore } from '../../src/renderer/features/address/settings-place.js';
import { useTeamAddress } from '../../src/renderer/features/team/settings/use-team-address.js';

describe('useTeamAddress', () => {
  afterEach(() => {
    cleanup();
  });

  it('reports the team and page shown while Team settings is open', () => {
    renderHook(() => {
      useTeamAddress('T1', 'people');
    });
    expect(useSettingsPlaceStore.getState()).toMatchObject({ page: 'people', team: 'T1' });
  });

  it('reports nothing once Team settings closes', () => {
    const { unmount } = renderHook(() => {
      useTeamAddress('T1', 'people');
    });
    unmount();
    // App settings or View profile from the account menu: the address must not keep the team page.
    expect(useSettingsPlaceStore.getState()).toMatchObject({ page: undefined, team: undefined });
  });
});
