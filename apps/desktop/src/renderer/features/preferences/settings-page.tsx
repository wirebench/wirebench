import { Suspense, lazy } from 'react';
import { useUiStore } from '../../state/ui.js';

/**
 * Loaded on demand: the editor pulls in every section's form (and the shortcuts keymap with
 * them), which is a lot of code for a page most sessions never open.
 */
const PreferencesEditor = lazy(async () => {
  const module = await import('./preferences-editor.js');
  return { default: module.PreferencesEditor };
});

/**
 * Settings, as a page in the window rather than a modal over it.
 *
 * While open it takes the place of the workbench (the shell keeps the workbench mounted but
 * hidden, so nothing behind it loses its state), and "Back to app" or Escape hands the window
 * back. Every route into Settings — the activity bar, ⌘, / Ctrl+,, the command palette, a
 * section-specific link — goes through `useUiStore.openPreferences`.
 */
export function SettingsPage() {
  const open = useUiStore((state) => state.preferences.open);
  const section = useUiStore((state) => state.preferences.section);
  if (!open) {
    return null;
  }

  return (
    <div data-testid="settings-page" className="flex min-h-0 min-w-0 flex-1 bg-surface-base">
      <Suspense fallback={<p className="p-4 text-sm text-fg-subtle">Loading settings…</p>}>
        {/* Remounted per section so the editor's own `initialSection` state is re-read: opening
            Settings from a section-specific route must land on that section even when the page
            was last left somewhere else. Every preference applies the moment it changes, so
            there is no draft to lose by leaving. */}
        <PreferencesEditor key={section ?? 'default'} {...(section === undefined ? {} : { initialSection: section })} />
      </Suspense>
    </div>
  );
}
