import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  ArrowLeft,
  ArrowLeftRight,
  BadgeCheck,
  Braces,
  CircleUser,
  Ellipsis,
  FileCode,
  GitBranch,
  KeyRound,
  Keyboard,
  Palette,
  Radio,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  ToggleRight,
  Smartphone,
  SquareTerminal,
  Waypoints,
  type LucideIcon,
  Puzzle,
} from 'lucide-react';
import { Button } from '../../components/button.js';
import {
  SettingsCard,
  SettingsRow,
  SettingsRowsControllerProvider,
  SettingsSearchProvider,
  SettingsVariantProvider,
  type SettingsRowsController,
} from '../../components/settings-grid.js';
import { detectPlatform } from '../../lib/platform.js';
import type { CommandContext } from '../../lib/commands.js';
import { isLockedByPolicy, usePreferencesStore } from '../../state/preferences.js';
import { useUiStore } from '../../state/ui.js';
import { HttpSection } from './sections/http-section.js';
import { WsiSection } from './sections/connection-sections.js';
import { ProxySection, SslSection } from './network-section.js';
import { GitSection } from './sections/git-section.js';
import { RestSection } from './sections/rest-section.js';
import { WsdlSection } from './sections/wsdl-section.js';
import { AppearanceSection } from './sections/appearance-section.js';
import { BehaviourSection } from './sections/behaviour-section.js';
import { FeaturesSection } from './sections/features-section.js';
import { PluginsSection } from './sections/plugins-section.js';
import { UpdatesSection } from './sections/updates-section.js';
import { AccountsSection } from './sections/accounts-section.js';
import { SecretsSection } from './sections/secrets-section.js';
import { MocksSection } from './sections/mocks-section.js';
import { SshSection } from './sections/ssh-section.js';
import { TerminalSection } from './sections/terminal-section.js';
import { ShortcutsSection } from './sections/shortcuts-section.js';
import { TokensSection } from './sections/tokens-section.js';
import type { SectionProps } from './sections/section-props.js';
import {
  SETTINGS_NAV,
  sectionsForSearch,
  canReset,
  isModified,
  resetPatch,
  resolveSection,
  sectionById,
  sectionKeys,
  sectionModified,
  type SettingsSectionId,
  type SettingsSectionRequest,
} from './settings-model.js';

const ICONS: Readonly<Record<SettingsSectionId, LucideIcon>> = {
  appearance: Palette,
  behaviour: SlidersHorizontal,
  features: ToggleRight,
  plugins: Puzzle,
  shortcuts: Keyboard,
  updates: RefreshCw,
  http: ArrowLeftRight,
  rest: Braces,
  wsdl: FileCode,
  wsi: BadgeCheck,
  proxy: Waypoints,
  ssl: ShieldCheck,
  git: GitBranch,
  mocks: Radio,
  terminal: SquareTerminal,
  ssh: Server,
  secrets: KeyRound,
  accounts: CircleUser,
  tokens: Smartphone,
};

/** The form for one section; `context` is only the Shortcuts table's. */
function SectionBody({
  id,
  props,
  context,
}: {
  readonly id: SettingsSectionId;
  readonly props: SectionProps;
  readonly context: CommandContext;
}) {
  switch (id) {
    case 'appearance':
      return <AppearanceSection {...props} />;
    case 'behaviour':
      return <BehaviourSection {...props} />;
    case 'features':
      return <FeaturesSection {...props} />;
    case 'plugins':
      return <PluginsSection />;
    case 'shortcuts':
      return <ShortcutsSection context={context} />;
    case 'updates':
      return <UpdatesSection {...props} />;
    case 'http':
      return <HttpSection {...props} />;
    case 'rest':
      return <RestSection {...props} />;
    case 'wsdl':
      return <WsdlSection {...props} />;
    case 'wsi':
      return <WsiSection {...props} />;
    case 'proxy':
      return <ProxySection {...props} />;
    case 'ssl':
      return <SslSection {...props} />;
    case 'git':
      return <GitSection {...props} />;
    case 'mocks':
      return <MocksSection {...props} />;
    case 'terminal':
      return <TerminalSection {...props} />;
    case 'ssh':
      return <SshSection {...props} />;
    case 'secrets':
      return <SecretsSection {...props} />;
    case 'accounts':
      return <AccountsSection {...props} />;
    case 'tokens':
      return <TokensSection />;
  }
}

/** The layers that own Escape while they are open. */
const ESCAPE_LAYERS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/**
 * Whether an Escape someone already handled was spent closing a layer that is still open (a menu,
 * a dialog, a listbox), so it must not also leave Settings.
 *
 * A tooltip handles Escape too: Radix closes it and marks the key handled in the capture phase.
 * After a click on the rail's Settings button the focus stays on that button, its tooltip is
 * open, and Escape used to stop there (G06). A tooltip is not a layer the key belongs to, so an
 * Escape that only closed one still leaves Settings.
 */
export function escapeClaimedElsewhere(event: Pick<KeyboardEvent, 'defaultPrevented'>, doc: Document): boolean {
  return event.defaultPrevented && doc.querySelector(ESCAPE_LAYERS) !== null;
}

/** Whether a key press in `target` belongs to that element (typing, picking) rather than the page. */
function capturesEscape(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.closest(ESCAPE_LAYERS) !== null) {
    return true;
  }
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  return (
    target instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'submit', 'reset'].includes(target.type)
  );
}

export interface PreferencesEditorProps {
  /** Which section to show first; defaults to Appearance. The old `editor`/`ui` ids land there too. */
  readonly initialSection?: SettingsSectionRequest;
}

/**
 * The Settings page: a sidebar with the way back, a search across every setting and the grouped
 * section list; the chosen section's form (or the search results) in a centred column on the
 * right. Every edit is a patch — one field, not a whole document — so two windows editing
 * different sections cannot clobber one another.
 */
export function PreferencesEditor({ initialSection }: PreferencesEditorProps) {
  const [active, setActive] = useState<SettingsSectionId>(() => resolveSection(initialSection));
  const [rawQuery, setRawQuery] = useState('');
  const query = rawQuery.trim().toLowerCase();
  const searchRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  const preferences = usePreferencesStore((state) => state.preferences);
  const update = usePreferencesStore((state) => state.update);
  const reset = usePreferencesStore((state) => state.reset);
  const policy = usePreferencesStore((state) => state.policy);
  const close = useUiStore((state) => state.setPreferencesOpen);

  const platform = useMemo(() => detectPlatform(), []);
  const uiSnapshot = useUiStore((state) => state.snapshot);
  const selection = useUiStore((state) => state.selection);
  const commandContext: CommandContext = useMemo(
    () => ({ platform, ui: uiSnapshot(), selection }),
    [platform, uiSnapshot, selection],
  );

  const locked = useCallback((key: string) => isLockedByPolicy(policy, key), [policy]);
  const sectionProps: SectionProps = {
    preferences,
    update: (patch) => {
      void update(patch);
    },
    locked,
  };
  const controller: SettingsRowsController = useMemo(
    () => ({
      isModified: (key) => isModified(preferences, key),
      canReset: (key) => canReset(preferences, key),
      reset: (key) => {
        void update(resetPatch(preferences, [key]));
      },
      locked,
    }),
    [preferences, update, locked],
  );

  const resetSection = (id: SettingsSectionId): void => {
    const section = sectionById(id);
    if (section.keys.kind === 'stored') {
      void reset(section.keys.section);
    } else if (section.keys.kind === 'fields') {
      // Appearance and Behaviour each span two stored sections, so a stored-section reset would
      // also wipe the other page's fields; they are put back field by field instead. A locked
      // field is left out — main refuses a patch that touches one.
      const keys = sectionKeys(preferences, section).filter((key) => !locked(key));
      void update(resetPatch(preferences, keys));
    }
  };

  // Escape: clears a search first, then leaves Settings — unless the key belongs to whatever has
  // focus (a field reverting its draft, the shortcut recorder, an open menu or dialog).
  // ⌘F / Ctrl+F: focuses the search, ahead of any app-wide binding.
  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (escapeClaimedElsewhere(event, document)) {
          return;
        }
        const inSearch = event.target === searchRef.current;
        if (!inSearch && capturesEscape(event.target)) {
          return;
        }
        event.preventDefault();
        if (queryRef.current.length > 0) {
          setRawQuery('');
          return;
        }
        close(false);
      }
    };
    const onFind = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        event.stopPropagation();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keydown', onFind, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keydown', onFind, { capture: true });
    };
  }, [close]);

  const managed = policy !== undefined && policy.locked.length > 0;
  const section = sectionById(active);
  const searching = query.length > 0;

  return (
    <SettingsVariantProvider variant="card">
      <SettingsRowsControllerProvider controller={controller}>
        <div data-testid="preferences-editor" className="flex h-full min-h-0 w-full">
          <aside className="flex w-[232px] shrink-0 flex-col border-r border-hairline bg-surface-sunken">
            <button
              type="button"
              data-testid="settings-back"
              onClick={() => {
                close(false);
              }}
              className="mx-2.5 mt-3 mb-1.5 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-fg-muted hover:bg-surface-hover hover:text-fg-default focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
            >
              <ArrowLeft size={14} aria-hidden="true" />
              Back to app
            </button>
            <div className="relative mx-2.5 mt-1 mb-2.5">
              <Search
                size={12}
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-subtle"
              />
              <input
                ref={searchRef}
                type="text"
                data-testid="settings-search"
                aria-label="Search settings"
                placeholder="Search settings"
                autoComplete="off"
                spellCheck={false}
                value={rawQuery}
                onChange={(event) => {
                  setRawQuery(event.target.value);
                }}
                className="h-7.5 w-full rounded-md border border-hairline bg-surface-raised pr-12 pl-7 text-sm text-fg-default placeholder:text-fg-faint focus:border-accent focus:outline-none"
              />
              <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded-sm border border-hairline px-1 font-mono text-2xs text-fg-subtle">
                {platform === 'mac' ? '⌘F' : 'Ctrl+F'}
              </kbd>
            </div>
            <nav aria-label="Settings sections" className="min-h-0 flex-1 overflow-auto px-2.5 pb-3">
              {SETTINGS_NAV.map((group) => (
                <div key={group.title} className="mt-3 first:mt-1">
                  <h2 className="mb-1 px-2 text-xs font-medium text-fg-subtle">{group.title}</h2>
                  <ul>
                    {group.sections.map((entry) => {
                      const Icon = ICONS[entry.id];
                      const current = !searching && entry.id === active;
                      const changed = sectionModified(preferences, entry);
                      return (
                        <li key={entry.id}>
                          <button
                            type="button"
                            data-testid={`settings-nav-${entry.id}`}
                            aria-current={current ? 'page' : undefined}
                            {...(changed ? { 'data-modified': 'true' } : {})}
                            onClick={() => {
                              setActive(entry.id);
                              setRawQuery('');
                              mainRef.current?.scrollTo?.({ top: 0 });
                            }}
                            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none ${
                              current
                                ? 'bg-surface-active text-fg-default'
                                : 'text-fg-muted hover:bg-surface-hover hover:text-fg-default'
                            }`}
                          >
                            <Icon size={14} aria-hidden="true" className="shrink-0 opacity-80" />
                            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                            {changed && (
                              <span
                                aria-hidden="true"
                                data-testid="settings-nav-modified"
                                title="Has changed settings"
                                className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                              />
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </nav>
          </aside>

          <main ref={mainRef} className="min-w-0 flex-1 overflow-auto">
            <div className="mx-auto max-w-[720px] px-8 pt-9 pb-20">
              {searching ? (
                <SearchResults
                  query={query}
                  rawQuery={rawQuery.trim()}
                  props={sectionProps}
                  context={commandContext}
                  onOpen={(id) => {
                    setActive(id);
                    setRawQuery('');
                  }}
                />
              ) : (
                <>
                  <div className="mb-1.5 flex items-end justify-between gap-4">
                    <h1 className="text-[22px] leading-tight font-semibold text-fg-default">{section.label}</h1>
                    {section.keys.kind !== 'none' && (
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger asChild>
                          <button
                            type="button"
                            data-testid="settings-section-menu"
                            aria-label={`More actions for ${section.label}`}
                            className="flex h-7 items-center rounded-md border border-hairline bg-surface-raised px-2.5 text-fg-muted hover:bg-surface-hover hover:text-fg-default focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
                          >
                            <Ellipsis size={14} aria-hidden="true" />
                          </button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content
                            align="end"
                            sideOffset={4}
                            className="z-dropdown min-w-56 rounded-lg border border-hairline-strong bg-surface-overlay p-1 shadow-lg"
                          >
                            <DropdownMenu.Item
                              data-testid="settings-reset-section"
                              onSelect={() => {
                                resetSection(active);
                              }}
                              className="cursor-pointer rounded-md px-2.5 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-surface-hover"
                            >
                              Reset {section.label} to defaults
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
                    )}
                  </div>
                  <p className="mb-6 text-sm text-fg-subtle">{section.subtitle}</p>

                  {managed && (
                    <p
                      role="note"
                      data-testid="preferences-policy"
                      className="mb-5 rounded-lg border border-status-warning px-3 py-2.5 text-sm text-fg-muted"
                    >
                      Some settings are managed by your organization and marked “Managed”. They come from{' '}
                      <code className="font-mono text-xs">{policy.path}</code>.
                      {policy.ignored.length > 0 && (
                        <> The policy also names settings it cannot lock: {policy.ignored.join(', ')}.</>
                      )}
                    </p>
                  )}
                  {policy?.error !== undefined && (
                    <p
                      role="alert"
                      data-testid="preferences-policy-error"
                      className="mb-5 rounded-lg border border-status-danger px-3 py-2.5 text-sm text-fg-muted"
                    >
                      The managed-preferences policy at <code className="font-mono text-xs">{policy.path}</code> was not
                      applied: {policy.error}
                    </p>
                  )}

                  <div data-testid={`settings-section-${active}`}>
                    <SectionBody id={active} props={sectionProps} context={commandContext} />
                  </div>
                </>
              )}
            </div>
          </main>
        </div>
      </SettingsRowsControllerProvider>
    </SettingsVariantProvider>
  );
}

/**
 * Every setting that matches the query, across all sections, as one list with fully working
 * controls; each row says where it lives. Sections whose content is not a list of settings (the
 * shortcuts table, CI tokens) are found by name and offer a way to open them.
 */
function SearchResults({
  query,
  rawQuery,
  props,
  context,
  onOpen,
}: {
  readonly query: string;
  readonly rawQuery: string;
  readonly props: SectionProps;
  readonly context: CommandContext;
  readonly onOpen: (id: SettingsSectionId) => void;
}) {
  const resultsRef = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState<number | undefined>(undefined);
  // The rows decide for themselves whether they match (they know their label, hint and group),
  // so the total is read back from what rendered.
  useLayoutEffect(() => {
    const next = resultsRef.current?.querySelectorAll('[data-setting-row]').length ?? 0;
    if (next !== count) {
      setCount(next);
    }
  });

  return (
    <>
      <h1 className="mb-1.5 text-[22px] leading-tight font-semibold text-fg-default">Search</h1>
      <p data-testid="settings-search-summary" className="mb-6 text-sm text-fg-subtle">
        {count === undefined ? '' : `${String(count)} setting${count === 1 ? '' : 's'} match “${rawQuery}”`}
      </p>
      <div ref={resultsRef} className={count === 0 ? 'hidden' : ''}>
        <SettingsCard testId="settings-search-results">
          {sectionsForSearch(query).map((section) => (
            <SettingsSearchProvider
              key={section.id}
              search={{
                query,
                crumb: `${section.group} › ${section.label}`,
                section: section.label,
                ...(section.keywords === undefined ? {} : { keywords: section.keywords }),
              }}
            >
              {section.searchable ? (
                <SectionBody id={section.id} props={props} context={context} />
              ) : (
                <SettingsRow label={section.label} hint={section.subtitle}>
                  <Button
                    variant="secondary"
                    data-testid={`settings-search-open-${section.id}`}
                    onClick={() => {
                      onOpen(section.id);
                    }}
                  >
                    Open
                  </Button>
                </SettingsRow>
              )}
            </SettingsSearchProvider>
          ))}
        </SettingsCard>
      </div>
      {count === 0 && (
        <p data-testid="settings-search-empty" className="py-10 text-center text-sm text-fg-subtle">
          No settings match. Try “proxy”, “timeout” or “font”.
        </p>
      )}
    </>
  );
}
