import { useEditorsStore } from '../../state/editors.js';
import type { PreferencesSectionWire } from '../../../shared/wire-types.js';
import { PREFERENCES_TAB_ID } from './preferences-editor.js';

const SECTIONS: readonly { readonly id: PreferencesSectionWire; readonly label: string }[] = [
  { id: 'http', label: 'HTTP' },
  { id: 'proxy', label: 'Proxy' },
  { id: 'ssl', label: 'SSL' },
  { id: 'wsdl', label: 'WSDL' },
  { id: 'wsi', label: 'WS-I' },
  { id: 'editor', label: 'Editor' },
  { id: 'ui', label: 'UI' },
  { id: 'updates', label: 'Updates' },
  { id: 'shortcuts', label: 'Shortcuts' },
];

/**
 * Opens (or focuses) the Preferences tab, optionally on a given section. Shared by the sidebar
 * list, the `preferences.open` command and `view.showSettings`. `openOrReplace` rather than
 * `open` so clicking a second section in the sidebar moves the already-open tab to it instead
 * of leaving it where it was.
 */
export function openPreferencesTab(section?: PreferencesSectionWire): void {
  useEditorsStore.getState().openOrReplace({
    id: PREFERENCES_TAB_ID,
    kind: 'preferences',
    title: 'Preferences',
    ...(section !== undefined ? { preferencesSection: section } : {}),
  });
}

/**
 * The Settings activity-bar view: the list of preference sections. Clicking one opens the
 * Preferences tab in the editor area — the sidebar is a table of contents, not a second editor.
 */
export function PreferencesSectionList() {
  return (
    <nav aria-label="Preference sections" className="min-h-0 flex-1 overflow-auto py-1">
      <ul>
        {SECTIONS.map((section) => (
          <li key={section.id}>
            <button
              type="button"
              onClick={() => {
                openPreferencesTab(section.id);
              }}
              className="w-full px-3 py-1 text-left text-sm text-fg-default hover:bg-surface-raised"
            >
              {section.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
