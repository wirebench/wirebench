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
}

export const useSettingsPlaceStore = create<SettingsPlace>()(() => ({ page: undefined, team: undefined }));

/** Reports the page (and team) a settings page shows while it is mounted; `page` stays unset until it settles. */
export function useReportSettingsPlace(page: string | undefined, team?: string): void {
  useEffect(() => {
    useSettingsPlaceStore.setState({ page, team });
  }, [page, team]);
  useEffect(() => () => useSettingsPlaceStore.setState({ page: undefined, team: undefined }), []);
}
