/**
 * The Settings page's model: which sections exist and how they are grouped, which preferences
 * each one holds, and the pure questions the page asks about a preferences document — is this
 * key changed from its default, can it be put back on its own, which patch does that.
 *
 * Kept free of React and of any value import from the wire-types modules (whose zod schemas
 * compile validators at runtime, which the renderer's CSP forbids): the defaults come from the
 * renderer's own copy, and the wire types are imported as types only.
 */

import { DEFAULT_PREFERENCES_WIRE } from '../../state/preferences-defaults.js';
import type {
  PreferencesPatchWire,
  PreferencesSectionWire,
  PreferencesStoredSectionWire,
  PreferencesWire,
} from '../../../shared/wire-base.js';

/** A section of the Settings page. */
export type SettingsSectionId =
  | 'appearance'
  | 'behaviour'
  | 'features'
  | 'shortcuts'
  | 'updates'
  | 'http'
  | 'rest'
  | 'wsdl'
  | 'wsi'
  | 'proxy'
  | 'ssl'
  | 'git'
  | 'mocks'
  | 'terminal'
  | 'ssh'
  | 'secrets'
  | 'accounts'
  | 'tokens';

/**
 * What a caller may ask Settings to open on: a page section, or one of the stored-section ids
 * (`editor`, `ui`) callers used before Appearance and Behaviour split them. Those two are
 * aliases — see {@link resolveSection}.
 */
export type SettingsSectionRequest = SettingsSectionId | PreferencesSectionWire;

/** The preferences a section holds, for its modified dot and its "Reset … to defaults". */
type SectionKeys =
  /** A whole stored section: reset through `preferences.reset`. */
  | { readonly kind: 'stored'; readonly section: PreferencesStoredSectionWire }
  /** Fields drawn from several stored sections: reset by patching each back to its default. */
  | { readonly kind: 'fields'; readonly keys: readonly string[] }
  /** Holds no preferences (CI tokens live on the server). */
  | { readonly kind: 'none' };

export interface SettingsSection {
  readonly id: SettingsSectionId;
  readonly label: string;
  /** The one line under the section's title. */
  readonly subtitle: string;
  readonly keys: SectionKeys;
  /** Whether the search renders this section's rows; the others are found by name only. */
  readonly searchable: boolean;
  /** More words every row of the section matches on, beside its name: what people search for it by. */
  readonly keywords?: readonly string[];
}

export interface SettingsNavGroup {
  readonly title: string;
  readonly sections: readonly SettingsSection[];
}

/** Appearance: how things look. Fields only; nothing here changes what they store. */
export const APPEARANCE_KEYS = [
  'ui.theme',
  'editor.fontFamily',
  'editor.fontSize',
  'editor.tabSize',
  'editor.lineNumbers',
  'editor.wordWrap',
  'ui.defaultLayout.orientation',
  'ui.defaultLayout.mode',
] as const;

/** Behaviour: what the app does while you work. */
export const BEHAVIOUR_KEYS = [
  'editor.autoValidateOnSend',
  'editor.autoFormatResponses',
  'editor.autosave',
  'ui.confirmOnDelete',
  'ui.previewTabs',
  'ui.historyCap',
  'ui.logSize',
] as const;

const stored = (section: PreferencesStoredSectionWire): SectionKeys => ({ kind: 'stored', section });

export const SETTINGS_NAV: readonly SettingsNavGroup[] = [
  {
    title: 'General',
    sections: [
      {
        id: 'appearance',
        label: 'Appearance',
        subtitle: 'Theme, editor fonts and the default request layout.',
        keys: { kind: 'fields', keys: APPEARANCE_KEYS },
        searchable: true,
      },
      {
        id: 'behaviour',
        label: 'Behaviour',
        subtitle: 'How the app acts while you work.',
        keys: { kind: 'fields', keys: BEHAVIOUR_KEYS },
        searchable: true,
      },
      {
        id: 'features',
        label: 'Features',
        subtitle: 'Turn protocols and optional features off on this machine.',
        keys: stored('features'),
        searchable: true,
        keywords: ['switch', 'protocol', 'experimental', 'policy', 'grpc', 'soap', 'rest', 'websocket', 'scripts'],
      },
      {
        id: 'shortcuts',
        label: 'Keyboard shortcuts',
        subtitle: 'Rebind any command.',
        keys: stored('shortcuts'),
        searchable: false,
      },
      { id: 'updates', label: 'Updates', subtitle: 'Release checks.', keys: stored('updates'), searchable: true },
    ],
  },
  {
    title: 'Requests',
    sections: [
      { id: 'http', label: 'HTTP', subtitle: 'Defaults for every HTTP send.', keys: stored('http'), searchable: true },
      {
        id: 'rest',
        label: 'REST',
        subtitle: 'Redirects, the Accept header and response handling.',
        keys: stored('rest'),
        searchable: true,
      },
      {
        id: 'wsdl',
        label: 'WSDL',
        subtitle: 'Definition caching and generated SOAP requests.',
        keys: stored('wsdl'),
        searchable: true,
      },
      { id: 'wsi', label: 'WS-I', subtitle: 'Conformance checks.', keys: stored('wsi'), searchable: true },
    ],
  },
  {
    title: 'Network',
    sections: [
      {
        id: 'proxy',
        label: 'Proxy',
        subtitle: 'How requests reach the network.',
        keys: stored('proxy'),
        searchable: true,
      },
      {
        id: 'ssl',
        label: 'SSL / TLS',
        subtitle: 'Certificates and protocol versions.',
        keys: stored('ssl'),
        searchable: true,
      },
    ],
  },
  {
    title: 'Workspace',
    sections: [
      {
        id: 'git',
        label: 'Git',
        subtitle: 'The git executable shared workspaces sync with.',
        keys: stored('git'),
        searchable: true,
      },
      { id: 'mocks', label: 'Mock services', subtitle: 'Local mock servers.', keys: stored('mocks'), searchable: true },
      {
        id: 'terminal',
        label: 'Terminal',
        subtitle: 'SSH terminal fonts, colours and behaviour.',
        keys: stored('terminal'),
        searchable: true,
        keywords: ['ssh', 'shell', 'console'],
      },
      {
        id: 'ssh',
        label: 'SSH',
        subtitle: 'Connection defaults for hosts that do not set their own.',
        keys: stored('ssh'),
        searchable: true,
      },
      {
        id: 'secrets',
        label: 'Secrets',
        subtitle: 'Secret sources and the app lock for SSH secrets.',
        keys: stored('secrets'),
        searchable: true,
      },
    ],
  },
  {
    title: 'Account',
    sections: [
      {
        id: 'accounts',
        label: 'Accounts',
        subtitle: 'Servers you are signed in to.',
        keys: stored('accounts'),
        searchable: true,
      },
      {
        id: 'tokens',
        label: 'Devices & tokens',
        subtitle: 'CI tokens for the open server workspace.',
        keys: { kind: 'none' },
        searchable: false,
      },
    ],
  },
];

/** Every section, in nav order, with the title of the group it sits in. */
export const SETTINGS_SECTIONS: readonly (SettingsSection & { readonly group: string })[] = SETTINGS_NAV.flatMap(
  (group) => group.sections.map((section) => ({ ...section, group: group.title })),
);

/**
 * The sections in the order search lists their rows: a section named by the query comes first, then one
 * whose name starts with it, then the rest in nav order. "ssh" lists the SSH page before Terminal, which
 * only has it as a keyword (#594). `query` is already trimmed and lower case.
 */
export function sectionsForSearch(query: string): readonly (SettingsSection & { readonly group: string })[] {
  const rank = (section: SettingsSection): number => {
    const label = section.label.toLowerCase();
    if (label === query) return 0;
    return label.startsWith(query) ? 1 : 2;
  };
  // Array.prototype.sort is stable, so equal ranks keep nav order.
  return [...SETTINGS_SECTIONS].sort((a, b) => rank(a) - rank(b));
}

/** The section Settings opens on when the caller names none. */
export const DEFAULT_SECTION: SettingsSectionId = 'appearance';

/** Maps a caller's request onto a page section; the old `editor` and `ui` ids land on Appearance. */
export function resolveSection(request: SettingsSectionRequest | undefined): SettingsSectionId {
  if (request === undefined || request === 'editor' || request === 'ui') {
    return DEFAULT_SECTION;
  }
  return request;
}

export function sectionById(id: SettingsSectionId): SettingsSection & { readonly group: string } {
  const section = SETTINGS_SECTIONS.find((candidate) => candidate.id === id);
  if (section === undefined) {
    throw new Error(`Unknown settings section ${id}`);
  }
  return section;
}

/**
 * Keys `preferences.update` refuses (main sets them through its own pickers), plus the markers
 * that record such a pick. They can show as changed, but only their own Clear puts them back.
 */
const MAIN_ONLY_KEYS: ReadonlySet<string> = new Set([
  'ssl.caBundlePath',
  'ssl.caBundlePickedByMain',
  'git.path',
  'git.pathPickedByMain',
]);

function valueAt(document: PreferencesWire, key: string): unknown {
  let value: unknown = document;
  for (const part of key.split('.')) {
    if (typeof value !== 'object' || value === null) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** An unset optional text field and an empty one mean the same thing. */
function normalise(value: unknown): unknown {
  return value === '' ? undefined : value;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));
}

/** Whether the dotted `key` holds something other than its built-in default. */
export function isModified(preferences: PreferencesWire, key: string): boolean {
  return !sameValue(valueAt(preferences, key), valueAt(DEFAULT_PREFERENCES_WIRE, key));
}

/**
 * The value that puts `key` back to its default through `preferences.update`, or `undefined`
 * when there is none: an update leaves a field alone when it is sent `undefined`, so an optional
 * field without a default can be put back only when it is text (cleared to `''`); and a
 * main-only key not at all.
 */
function resetValue(preferences: PreferencesWire, key: string): { readonly value: unknown } | undefined {
  if (MAIN_ONLY_KEYS.has(key)) {
    return undefined;
  }
  // A feature switch has no default value of its own: removing the key (a `null` patch) puts the
  // descriptor's default back (phase 4 spec §4.1).
  if (key.startsWith('features.')) {
    return { value: null };
  }
  const fallback = valueAt(DEFAULT_PREFERENCES_WIRE, key);
  if (fallback !== undefined) {
    return { value: fallback };
  }
  return typeof valueAt(preferences, key) === 'string' ? { value: '' } : undefined;
}

/** Whether a per-row Reset can put `key` back on its own. */
export function canReset(preferences: PreferencesWire, key: string): boolean {
  return resetValue(preferences, key) !== undefined;
}

/**
 * One patch that puts every resettable key in `keys` back to its default. A nested key
 * (`ui.defaultLayout.orientation`) is sent with its siblings, because a patch replaces a nested
 * object rather than merging into it.
 */
export function resetPatch(preferences: PreferencesWire, keys: readonly string[]): PreferencesPatchWire {
  const patch: Record<string, Record<string, unknown>> = {};
  for (const key of keys) {
    const reset = resetValue(preferences, key);
    if (reset === undefined) {
      continue;
    }
    const [section, field, nested] = key.split('.') as [string, string, string | undefined];
    const target = (patch[section] ??= {});
    if (nested === undefined) {
      target[field] = reset.value;
    } else {
      const current = (target[field] ?? valueAt(preferences, `${section}.${field}`) ?? {}) as Record<string, unknown>;
      target[field] = { ...current, [nested]: reset.value };
    }
  }
  return patch;
}

/** The keys of a stored section that can differ from the defaults, from both documents. */
function storedKeys(preferences: PreferencesWire, section: PreferencesStoredSectionWire): string[] {
  const own = Object.keys((preferences as Record<string, object>)[section] ?? {});
  const defaults = Object.keys((DEFAULT_PREFERENCES_WIRE as Record<string, object>)[section] ?? {});
  return [...new Set([...own, ...defaults])]
    .filter((field) => !field.endsWith('PickedByMain'))
    .map((field) => `${section}.${field}`);
}

/** The dotted keys a section holds; empty for a section with no preferences. */
export function sectionKeys(preferences: PreferencesWire, section: SettingsSection): readonly string[] {
  switch (section.keys.kind) {
    case 'stored':
      return storedKeys(preferences, section.keys.section);
    case 'fields':
      return section.keys.keys;
    case 'none':
      return [];
  }
}

/** Whether anything in the section differs from its default — the sidebar's dot. */
export function sectionModified(preferences: PreferencesWire, section: SettingsSection): boolean {
  return sectionKeys(preferences, section).some((key) => isModified(preferences, key));
}
