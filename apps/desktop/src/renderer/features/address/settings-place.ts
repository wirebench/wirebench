import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * The page a settings area shows, as the page itself settles it (a requested page it may not show falls back to
 * another): what the browser client's address names. Each settings page reports it; nothing else writes here.
 */
export interface SettingsPlace {
  readonly page: string | undefined;
  /** Team settings: the team shown. */
  readonly team: string | undefined;
  /** Team settings' Workspace overview: the workspace shown. */
  readonly workspace?: string | undefined;
}

export const useSettingsPlaceStore = create<SettingsPlace>()(() => ({
  page: undefined,
  team: undefined,
  workspace: undefined,
}));

/** Reports the page (and team, and workspace) a settings page shows while mounted; `page` stays unset until it settles. */
export function useReportSettingsPlace(page: string | undefined, team?: string, workspace?: string): void {
  useEffect(() => {
    useSettingsPlaceStore.setState({ page, team, workspace });
  }, [page, team, workspace]);
  useEffect(() => () => useSettingsPlaceStore.setState({ page: undefined, team: undefined, workspace: undefined }), []);
}
