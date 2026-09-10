import type { PreferencesPatchWire, PreferencesWire } from '../../../../shared/wire-types.js';

/** What every Preferences section receives: the current document and a patch applier. */
export interface SectionProps {
  readonly preferences: PreferencesWire;
  readonly update: (patch: PreferencesPatchWire) => void;
}
