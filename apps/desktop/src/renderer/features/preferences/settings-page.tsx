import { Suspense, lazy, useEffect } from 'react';
import { signedInServers, useAccountStore } from '../../state/account.js';
import { useSyncStore } from '../../state/sync.js';
import { useUiStore, type SettingsArea } from '../../state/ui.js';
import { settingsServerUrl, useServerSettingsStore } from './server/server-settings-store.js';
import type { SettingsSectionRequest } from './settings-model.js';
import type { UserSettingsPageId } from './user-settings-model.js';

/**
 * Loaded on demand: the editor pulls in every section's form (and the shortcuts keymap with
 * them), which is a lot of code for a page most sessions never open.
 */
const PreferencesEditor = lazy(async () => {
  const module = await import('./preferences-editor.js');
  return { default: module.PreferencesEditor };
});

/** User settings, loaded on demand like the App settings editor. */
const UserSettings = lazy(async () => {
  const module = await import('./user/user-settings.js');
  return { default: module.UserSettings };
});

/**
 * Settings, as a page in the window rather than a modal over it.
 *
 * While open it takes the place of the workbench (the shell keeps the workbench mounted but
 * hidden, so nothing behind it loses its state), and "Back to workspace" or Escape hands the window
 * back. Every route into Settings — the activity bar, ⌘, / Ctrl+,, the command palette, a
 * section-specific link — goes through `useUiStore.openPreferences`.
 */
export function SettingsPage() {
  const open = useUiStore((state) => state.preferences.open);
  const area = useUiStore((state) => state.preferences.area);
  const section = useUiStore((state) => state.preferences.section);
  // The Server group (hosted edition spec §22.13): the connected server's own settings, read each time Settings
  // opens; the server answers its server admins only, and the group shows only then. With several signed in, the open
  // workspace's server when it is shared on one, else the first (see `settingsServerUrl`).
  const linked = useSyncStore((state) => (state.status.kind === 'server' ? state.status.remote : undefined));
  const serverUrl = useAccountStore((state) => settingsServerUrl(signedInServers(state.servers), linked));
  useEffect(() => {
    if (open && serverUrl !== undefined) void useServerSettingsStore.getState().load(serverUrl);
    if (!open || serverUrl === undefined) useServerSettingsStore.getState().reset();
  }, [open, serverUrl]);
  if (!open) {
    return null;
  }
  const body = areaBody(area, section);
  if (body === null) {
    return null;
  }

  return (
    <div data-testid="settings-page" className="flex min-h-0 min-w-0 flex-1 bg-surface-base">
      <Suspense fallback={<p className="p-4 text-sm text-fg-subtle">Loading settings…</p>}>{body}</Suspense>
    </div>
  );
}

/**
 * The open area's page. Remounted per area and section (the key) so a page's own initial state is re-read: opening
 * Settings from a section-specific route must land on that section even when the page was last left somewhere else.
 * Every preference applies the moment it changes, so there is no draft to lose by leaving.
 */
function areaBody(area: SettingsArea, section: SettingsSectionRequest | UserSettingsPageId | undefined) {
  switch (area) {
    case 'app':
      return (
        <PreferencesEditor
          key={`app:${section ?? 'default'}`}
          // In App settings the section is always a section request (the store's `openPreferences`).
          {...(section === undefined ? {} : { initialSection: section as SettingsSectionRequest })}
        />
      );
    case 'user':
      return (
        <UserSettings
          key={`user:${section ?? 'default'}`}
          // In User settings the section is always a user page (the store's `openUserSettings`).
          {...(section === undefined ? {} : { initialPage: section as UserSettingsPageId })}
        />
      );
    case 'team':
      // No page yet; nothing opens these areas until User and Team settings land (plan Tasks 7–8).
      return null;
  }
}
