import type { PreferencesWire } from '@shared/wire-base.js';
import type { GroupEntryWire, TerminalEntryWire } from '@shared/ssh-wire.js';
import { PREFERENCE_LIMITS } from '../../state/preference-limits.js';
import { INPUT_CLASS, InheritedField, sourceName, type Provenance } from './inherited-field.js';
import { APP_SCHEME_ID, schemeLabel, TERMINAL_SCHEMES } from './terminal-schemes.js';

/** Where a level with no setting of its own gets it from when no group sets it. */
const PREFERENCES = { group: 'Preferences' } as const;

/** What the enclosing groups (outermost first) hand this level, per field; Preferences → Terminal when none does. */
export function inheritedTerminal(
  chain: readonly GroupEntryWire[],
  prefs: PreferencesWire['terminal'],
): { scheme: Provenance<string>; fontSize: Provenance<number> } {
  const nearest = <K extends keyof TerminalEntryWire>(key: K): GroupEntryWire | undefined =>
    [...chain].reverse().find((group) => group.terminal?.[key] !== undefined);
  const schemeGroup = nearest('scheme');
  const sizeGroup = nearest('fontSize');
  return {
    scheme:
      schemeGroup === undefined
        ? { value: prefs.colorScheme, from: PREFERENCES }
        : { value: schemeGroup.terminal?.scheme, from: { group: schemeGroup.name } },
    fontSize:
      sizeGroup === undefined
        ? { value: prefs.fontSize, from: PREFERENCES }
        : { value: sizeGroup.terminal?.fontSize, from: { group: sizeGroup.name } },
  };
}

const { min, max } = PREFERENCE_LIMITS['terminal.fontSize'];

/** Why this level's block cannot be saved, or undefined. */
export function terminalProblem(own: TerminalEntryWire): string | undefined {
  const size = own.fontSize;
  if (size === undefined || (Number.isInteger(size) && size >= min && size <= max)) return undefined;
  return `Font size must be a whole number from ${String(min)} to ${String(max)}`;
}

/** The block as saved: no key for a field that inherits. */
export function cleanTerminal(own: TerminalEntryWire): TerminalEntryWire {
  return {
    ...(own.scheme === undefined ? {} : { scheme: own.scheme }),
    ...(own.fontSize === undefined ? {} : { fontSize: own.fontSize }),
  };
}

export interface HostTerminalSectionProps {
  /** This level's own `terminal` block. */
  readonly own: TerminalEntryWire;
  readonly inherited: ReturnType<typeof inheritedTerminal>;
  readonly onChange: (own: TerminalEntryWire) => void;
}

/**
 * The host and group form's Terminal section: the colour scheme and font size this level's terminals use.
 * Each shows what it inherits and from where (a group, or Preferences); setting one here overrides it for
 * this level and everything under it.
 */
export function HostTerminalSection({ own, inherited, onChange }: HostTerminalSectionProps) {
  const problem = terminalProblem(own);
  const from = inherited.scheme.from;
  const inheritedScheme = `Inherit: ${schemeLabel(inherited.scheme.value ?? APP_SCHEME_ID)}, from ${
    typeof from === 'object' ? sourceName(from) : 'Preferences'
  }`;
  const ids = [APP_SCHEME_ID, ...TERMINAL_SCHEMES.map((scheme) => scheme.id)];
  // An id this version does not know (hosts.yaml from a newer one) stays selectable, so saving keeps it.
  if (own.scheme !== undefined && !ids.includes(own.scheme)) ids.push(own.scheme);
  return (
    <section aria-label="Terminal" className="flex flex-col gap-2">
      <h3 className="text-xs font-medium tracking-wider text-fg-subtle uppercase">Terminal</h3>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-fg-subtle">Colour scheme</span>
        <select
          aria-label="Colour scheme"
          className={INPUT_CLASS}
          value={own.scheme ?? ''}
          onChange={(e) => {
            onChange({ ...own, scheme: e.target.value === '' ? undefined : e.target.value });
          }}
        >
          <option value="">{inheritedScheme}</option>
          {ids.map((id) => (
            <option key={id} value={id}>
              {schemeLabel(id)}
            </option>
          ))}
        </select>
      </label>
      <InheritedField
        label="Font size"
        type="number"
        provenance={inherited.fontSize}
        override={own.fontSize}
        onChange={(fontSize) => {
          onChange({ ...own, fontSize });
        }}
      />
      {problem !== undefined && (
        <p role="alert" className="text-xs text-status-danger">
          {problem}
        </p>
      )}
    </section>
  );
}
