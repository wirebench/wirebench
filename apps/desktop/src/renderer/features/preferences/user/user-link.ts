/**
 * The browser client's address of a User settings page (two-step sign-in spec §5.2): `?panel=user&page=<page>`, with
 * `&add=passkey` from the desktop's *Add a passkey*, which cannot run WebAuthn itself. Read beside the team settings
 * address (`team-link.ts`); a page that is not one is left out, so User settings opens on its first page.
 */
import { useUiStore } from '../../../state/ui.js';
import { USER_PAGES, type UserSettingsPageId } from '../user-settings-model.js';

export interface UserSettingsAddress {
  readonly page?: UserSettingsPageId;
  /** Open the passkey prompt at once on the Password page. */
  readonly addPasskey: boolean;
}

const isUserPage = (page: string): page is UserSettingsPageId => (USER_PAGES as readonly string[]).includes(page);

export function readUserDeepLink(search: string): UserSettingsAddress | undefined {
  const params = new URLSearchParams(search);
  if (params.get('panel') !== 'user') return undefined;
  const page = params.get('page');
  return {
    ...(page !== null && isUserPage(page) ? { page } : {}),
    addPasskey: page === 'password' && params.get('add') === 'passkey',
  };
}

/** Opens User settings at the page the address names; `false` when it names none. */
export function openUserDeepLink(location: Pick<Location, 'search'> = window.location): boolean {
  const address = readUserDeepLink(location.search);
  if (address === undefined) return false;
  useUiStore.getState().openUserSettings(address.page);
  return true;
}
