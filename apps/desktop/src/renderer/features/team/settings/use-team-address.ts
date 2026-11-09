/**
 * Team settings' place (settings split spec §5): the team and page it shows, reported for the browser client's
 * address (`?panel=team&team=<id>&page=<page>`), which the address sync writes as the team or page changes so a
 * reload, a bookmark or Back lands on the same page.
 */
import { useReportSettingsPlace } from '../../address/settings-place.js';
import type { TeamSettingsPageId } from '../team-settings-model.js';

/** Reports `teamId` and `page` while Team settings is open; nothing while there is no page yet. */
export function useTeamAddress(teamId: string | undefined, page: TeamSettingsPageId | undefined): void {
  useReportSettingsPlace(page, page === undefined ? undefined : teamId);
}
