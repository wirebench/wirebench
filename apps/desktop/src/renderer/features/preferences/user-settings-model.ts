/**
 * User settings' menu (settings split spec §2, §4): you, on every server. Pure, so which pages show is tested
 * without a page; the pages themselves come later.
 */

export const USER_PAGES = ['profile', 'password', 'servers', 'devices', 'tokens'] as const;
export type UserSettingsPageId = (typeof USER_PAGES)[number];

export interface UserPage {
  readonly id: UserSettingsPageId;
  readonly label: string;
  readonly subtitle: string;
}

export const USER_NAV: readonly { readonly title: 'You' | 'Access'; readonly pages: readonly UserPage[] }[] = [
  {
    title: 'You',
    pages: [
      { id: 'profile', label: 'Profile', subtitle: 'Your name, email and how you sign in.' },
      { id: 'password', label: 'Password', subtitle: 'Change the password you sign in with.' },
    ],
  },
  {
    title: 'Access',
    pages: [
      { id: 'servers', label: 'Servers you’re signed in to', subtitle: 'The servers this app is signed in to as you.' },
      { id: 'devices', label: 'Signed-in devices', subtitle: 'Where you are signed in, and signing one out.' },
      { id: 'tokens', label: 'CI tokens', subtitle: 'Tokens for the open server workspace.' },
    ],
  },
];

/** Password only where the chosen server allows local passwords; everything else always. */
export function userNav(facts: { readonly localPasswords: boolean }): typeof USER_NAV {
  if (facts.localPasswords) return USER_NAV;
  return USER_NAV.map((group) => ({ ...group, pages: group.pages.filter((page) => page.id !== 'password') }));
}

export const DEFAULT_USER_PAGE: UserSettingsPageId = 'profile';

/** `page` when the menu lists it for `facts`, else Profile. */
export function resolveUserPage(
  page: string | undefined,
  facts: { readonly localPasswords: boolean },
): UserSettingsPageId {
  const listed = userNav(facts).flatMap((group) => group.pages.map((entry) => entry.id));
  return listed.find((id) => id === page) ?? DEFAULT_USER_PAGE;
}
