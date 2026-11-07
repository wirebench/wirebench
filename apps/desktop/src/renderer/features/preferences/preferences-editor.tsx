import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
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
  Server,
  ShieldCheck,
  SlidersHorizontal,
  ToggleRight,
  Laptop,
  MonitorSmartphone,
  Smartphone,
  SquareTerminal,
  Waypoints,
  type LucideIcon,
  Puzzle,
  LogIn,
  Users,
  Send,
  Mail,
  Archive,
  CreditCard,
  Download,
  Trash2,
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
import { SettingsNavGroup, SettingsNavItem, SettingsPageHeader, SettingsShell } from './settings-shell.js';
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
import { AccountsSection } from './user/servers-page.js';
import { SecretsSection } from './sections/secrets-section.js';
import { MocksSection } from './sections/mocks-section.js';
import { SshSection } from './sections/ssh-section.js';
import { TerminalSection } from './sections/terminal-section.js';
import { ShortcutsSection } from './sections/shortcuts-section.js';
import { TokensSection } from './sections/tokens-section.js';
import { PairedBrowsersSection } from './sections/paired-browsers-section.js';
import { ThisMachineSection } from './sections/this-machine-section.js';
import type { SectionProps } from './sections/section-props.js';
import { ServerPage, SERVER_PAGE_LABELS } from './server/server-page.js';
import {
  HOSTED_ONLY_PAGES,
  isHosted,
  serverLabel,
  serverPages,
  useServerSettingsStore,
  type ServerPageId,
} from './server/server-settings-store.js';
import {
  availableNav,
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
  'this-machine': Laptop,
  'paired-browsers': MonitorSmartphone,
  tokens: Smartphone,
};

const SERVER_ICONS: Readonly<Record<ServerPageId, LucideIcon>> = {
  'sign-in': LogIn,
  provisioning: Users,
  'audit-forwarding': Send,
  email: Mail,
  retention: Archive,
  billing: CreditCard,
  export: Download,
  'close-account': Trash2,
};

/**
 * The *Server* group of the nav (hosted edition spec §22.13): shown only once the connected server answered its
 * settings read, which it does for its server admins only.
 */
function ServerNavGroup({
  current,
  onOpen,
}: {
  readonly current: ServerPageId | undefined;
  readonly onOpen: (page: ServerPageId) => void;
}) {
  const available = useServerSettingsStore((s) => s.available);
  const settings = useServerSettingsStore((s) => s.settings);
  const billing = useServerSettingsStore((s) => s.billing);
  const url = useServerSettingsStore((s) => s.url);
  if (!available || url === undefined) return null;
  return (
    <SettingsNavGroup title={`Server · ${serverLabel(url, billing)}`} testId="settings-nav-server">
      {serverPages(settings).map((page) => (
        <SettingsNavItem
          key={page}
          label={SERVER_PAGE_LABELS[page]}
          icon={SERVER_ICONS[page]}
          current={page === current}
          danger={page === 'close-account'}
          testId={`settings-nav-server-${page}`}
          onSelect={() => {
            onOpen(page);
          }}
        />
      ))}
    </SettingsNavGroup>
  );
}

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
    case 'this-machine':
      return <ThisMachineSection />;
    case 'paired-browsers':
      return <PairedBrowsersSection />;
    case 'tokens':
      return <TokensSection />;
  }
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
  // A page of the Server group, which stands in for `active` while one is open.
  const [serverPage, setServerPage] = useState<ServerPageId | undefined>(undefined);
  const serverAvailable = useServerSettingsStore((s) => s.available);
  const serverHosted = useServerSettingsStore((s) => isHosted(s.settings));
  const shownServerPage =
    serverPage !== undefined && serverAvailable && (serverHosted || !HOSTED_ONLY_PAGES.has(serverPage))
      ? serverPage
      : undefined;
  const [rawQuery, setRawQuery] = useState('');
  const query = rawQuery.trim().toLowerCase();

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

  const managed = policy !== undefined && policy.locked.length > 0;
  const section = sectionById(active);
  const searching = query.length > 0;

  const nav = (
    <>
      {availableNav().map((group) => (
        <SettingsNavGroup key={group.title} title={group.title}>
          {group.sections.map((entry) => (
            <SettingsNavItem
              key={entry.id}
              label={entry.label}
              icon={ICONS[entry.id]}
              current={!searching && shownServerPage === undefined && entry.id === active}
              modified={sectionModified(preferences, entry)}
              testId={`settings-nav-${entry.id}`}
              onSelect={() => {
                setActive(entry.id);
                setServerPage(undefined);
                setRawQuery('');
              }}
            />
          ))}
        </SettingsNavGroup>
      ))}
      <ServerNavGroup
        current={searching ? undefined : shownServerPage}
        onOpen={(page) => {
          setServerPage(page);
          setRawQuery('');
        }}
      />
    </>
  );

  return (
    <SettingsVariantProvider variant="card">
      <SettingsRowsControllerProvider controller={controller}>
        <SettingsShell
          area="app"
          nav={nav}
          search={{ value: rawQuery, onChange: setRawQuery, placeholder: 'Search settings' }}
          onBack={() => {
            close(false);
          }}
        >
          {!searching && shownServerPage !== undefined ? (
            <ServerPage page={shownServerPage} />
          ) : searching ? (
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
              <SettingsPageHeader
                title={section.label}
                subtitle={section.subtitle}
                actions={
                  section.keys.kind !== 'none' && (
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
                  )
                }
              />

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
        </SettingsShell>
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
