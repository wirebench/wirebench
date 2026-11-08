/**
 * Team settings' address (settings split spec §5): `?panel=team&team=<id>&page=<page>`, kept current as the team or
 * page changes so a reload or a bookmark lands on the same page. Always `replaceState`: a page change is not a
 * history entry, so Back leaves the app as it did before.
 */
import { useEffect } from 'react';
import { teamSettingsSearch, withoutTeamSettings } from '../team-link.js';
import type { TeamSettingsPageId } from '../team-settings-model.js';

function replaceSearch(search: string): void {
  const { pathname, hash } = window.location;
  if (search === window.location.search) return;
  window.history.replaceState(window.history.state, '', `${pathname}${search}${hash}`);
}

/** Writes the address whenever `teamId` or `page` changes; nothing while there is no page yet. */
export function useTeamAddress(teamId: string | undefined, page: TeamSettingsPageId | undefined): void {
  useEffect(() => {
    if (page === undefined) return;
    replaceSearch(teamSettingsSearch(window.location.search, { teamId, page }));
  }, [teamId, page]);
  // Leaving Team settings any other way than *Back* (App settings or View profile from the account menu, the
  // palette) takes its address with it, so a reload does not land back in Team settings.
  useEffect(() => clearTeamAddress, []);
}

/** Takes Team settings' parameters out of the address, for *Back to workspace*. */
export function clearTeamAddress(): void {
  replaceSearch(withoutTeamSettings(window.location.search));
}
