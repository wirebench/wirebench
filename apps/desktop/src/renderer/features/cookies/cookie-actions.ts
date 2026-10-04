import { useEditorsStore } from '../../state/editors.js';

/** The one Cookies tab of a window (cookie jar spec §3); opening it again focuses it. */
export const COOKIES_TAB_ID = 'cookies';

export function openCookiesTab(): void {
  useEditorsStore.getState().open({ id: COOKIES_TAB_ID, kind: 'cookies', title: 'Cookies' });
}
