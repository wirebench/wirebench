import { useMemo, useState } from 'react';
import { detectPlatform } from '../../lib/platform.js';
import type { CommandContext } from '../../lib/commands.js';
import { usePreferencesStore } from '../../state/preferences.js';
import { useUiStore } from '../../state/ui.js';
import type { PreferencesSectionWire } from '../../../shared/wire-types.js';
import { HttpSection } from './sections/http-section.js';
import { WsiSection } from './sections/connection-sections.js';
import { ProxySection, SslSection } from './network-section.js';
import { GitSection } from './sections/git-section.js';
import { RestSection } from './sections/rest-section.js';
import { WsdlSection } from './sections/wsdl-section.js';
import { EditorSection, UiSection } from './sections/editor-section.js';
import { UpdatesSection } from './sections/updates-section.js';
import { ShortcutsSection } from './sections/shortcuts-section.js';

/** The tab id the Preferences editor always opens under, so it is focused rather than duplicated. */
export const PREFERENCES_TAB_ID = 'preferences';

interface SectionEntry {
  readonly id: PreferencesSectionWire;
  readonly label: string;
}

const SECTIONS: readonly SectionEntry[] = [
  { id: 'http', label: 'HTTP' },
  { id: 'proxy', label: 'Proxy' },
  { id: 'ssl', label: 'SSL' },
  { id: 'rest', label: 'REST' },
  { id: 'git', label: 'Git' },
  { id: 'wsdl', label: 'WSDL' },
  { id: 'wsi', label: 'WS-I' },
  { id: 'editor', label: 'Editor' },
  { id: 'ui', label: 'UI' },
  { id: 'updates', label: 'Updates' },
  { id: 'shortcuts', label: 'Shortcuts' },
];

export interface PreferencesEditorProps {
  /** Which section to show first; defaults to HTTP. */
  readonly initialSection?: PreferencesSectionWire;
}

/**
 * The Preferences tab: a section list on the left, that section's form on the right, and a
 * "Reset section" button. Every edit is a patch — one field, not a whole document — so two
 * windows editing different sections cannot clobber one another.
 */
export function PreferencesEditor({ initialSection = 'http' }: PreferencesEditorProps) {
  const [active, setActive] = useState<PreferencesSectionWire>(initialSection);
  const preferences = usePreferencesStore((state) => state.preferences);
  const update = usePreferencesStore((state) => state.update);
  const reset = usePreferencesStore((state) => state.reset);

  const platform = useMemo(() => detectPlatform(), []);
  const uiSnapshot = useUiStore((state) => state.snapshot);
  const selection = useUiStore((state) => state.selection);
  const commandContext: CommandContext = useMemo(
    () => ({ platform, ui: uiSnapshot(), selection }),
    [platform, uiSnapshot, selection],
  );

  const apply = (patch: Parameters<typeof update>[0]): void => {
    void update(patch);
  };
  const sectionProps = { preferences, update: apply };

  return (
    <div data-testid="preferences-editor" className="flex h-full min-h-0">
      <nav aria-label="Preferences sections" className="w-40 shrink-0 overflow-auto border-r border-hairline py-2">
        <ul>
          {SECTIONS.map((section) => (
            <li key={section.id}>
              <button
                type="button"
                aria-current={section.id === active ? 'page' : undefined}
                onClick={() => {
                  setActive(section.id);
                }}
                className={`w-full px-3 py-1 text-left text-sm ${
                  section.id === active ? 'bg-surface-raised text-fg-default' : 'text-fg-muted hover:bg-surface-raised'
                }`}
              >
                {section.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="min-w-0 flex-1 overflow-auto px-4 py-3">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-md font-medium text-fg-default">
            {SECTIONS.find((section) => section.id === active)?.label}
          </h2>
          <button
            type="button"
            className="h-row shrink-0 rounded-md border border-hairline-strong bg-surface-raised px-3 text-sm text-fg-default hover:bg-surface-hover"
            onClick={() => {
              void reset(active);
            }}
          >
            Reset section
          </button>
        </div>

        {active === 'http' && <HttpSection {...sectionProps} />}
        {active === 'proxy' && <ProxySection {...sectionProps} />}
        {active === 'ssl' && <SslSection {...sectionProps} />}
        {active === 'rest' && <RestSection {...sectionProps} />}
        {active === 'git' && <GitSection {...sectionProps} />}
        {active === 'wsdl' && <WsdlSection {...sectionProps} />}
        {active === 'wsi' && <WsiSection {...sectionProps} />}
        {active === 'editor' && <EditorSection {...sectionProps} />}
        {active === 'ui' && <UiSection {...sectionProps} />}
        {active === 'updates' && <UpdatesSection {...sectionProps} />}
        {active === 'shortcuts' && <ShortcutsSection context={commandContext} />}
      </div>
    </div>
  );
}
