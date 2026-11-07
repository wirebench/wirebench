/**
 * The frame every settings area draws in (settings split spec §2): the way back, an optional header and search, the
 * area's menu on the left and its page on the right. It owns the page's keys, so App, Team and User settings leave and
 * search the same way: Escape clears a search first, then goes back; ⌘F / Ctrl+F focuses the search.
 */
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { ArrowLeft, Search, type LucideIcon } from 'lucide-react';
import { detectPlatform } from '../../lib/platform.js';
import type { SettingsArea } from '../../state/ui.js';

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
export function capturesEscape(target: EventTarget | null): boolean {
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

/** Kept per area so tests and e2e can tell the pages apart; App settings keeps its old id. */
const TEST_IDS: Readonly<Record<SettingsArea, string>> = {
  app: 'preferences-editor',
  team: 'team-settings',
  user: 'user-settings',
};

const NAV_LABELS: Readonly<Record<SettingsArea, string>> = {
  app: 'Settings sections',
  team: 'Team settings pages',
  user: 'User settings pages',
};

/** Lets a menu item bring the page back to its top when it opens another page. */
const ScrollToTop = createContext<() => void>(() => undefined);

export interface SettingsShellProps {
  readonly area: SettingsArea;
  /** Above the search: Team settings' switcher, User settings' server picker. */
  readonly header?: ReactNode;
  readonly nav: ReactNode;
  readonly search?: {
    readonly value: string;
    readonly onChange: (value: string) => void;
    readonly placeholder: string;
  };
  readonly children: ReactNode;
  readonly onBack: () => void;
}

export function SettingsShell({ area, header, nav, search, children, onBack }: SettingsShellProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const platform = useMemo(() => detectPlatform(), []);

  // Read through refs so the listeners are added once, yet always see the latest search and way back.
  const latest = useRef({ search, onBack });
  latest.current = { search, onBack };
  const hasSearch = search !== undefined;

  // Escape: clears a search first, then leaves — unless the key belongs to whatever has focus (a field
  // reverting its draft, the shortcut recorder, an open menu or dialog). ⌘F / Ctrl+F: focuses the search,
  // ahead of any app-wide binding.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (escapeClaimedElsewhere(event, document)) return;
      const inSearch = searchRef.current !== null && event.target === searchRef.current;
      if (!inSearch && capturesEscape(event.target)) return;
      event.preventDefault();
      const current = latest.current;
      if (current.search !== undefined && current.search.value.trim().length > 0) {
        current.search.onChange('');
        return;
      }
      current.onBack();
    };
    const onFind = (event: KeyboardEvent): void => {
      if (!hasSearch) return;
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
  }, [hasSearch]);

  const scrollToTop = useMemo(
    () => () => {
      mainRef.current?.scrollTo?.({ top: 0 });
    },
    [],
  );

  return (
    <ScrollToTop.Provider value={scrollToTop}>
      <div data-testid={TEST_IDS[area]} data-settings-area={area} className="flex h-full min-h-0 w-full">
        <aside className="flex w-[232px] shrink-0 flex-col border-r border-hairline bg-surface-sunken">
          <button
            type="button"
            data-testid="settings-back"
            onClick={onBack}
            className="mx-2.5 mt-3 mb-1.5 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-fg-muted hover:bg-surface-hover hover:text-fg-default focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          >
            <ArrowLeft size={14} aria-hidden="true" />
            Back to workspace
          </button>
          {header !== undefined && <div className="mx-2.5 mt-1 mb-1.5">{header}</div>}
          {search !== undefined && (
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
                aria-label={search.placeholder}
                placeholder={search.placeholder}
                autoComplete="off"
                spellCheck={false}
                value={search.value}
                onChange={(event) => {
                  search.onChange(event.target.value);
                }}
                className="h-7.5 w-full rounded-md border border-hairline bg-surface-raised pr-12 pl-7 text-sm text-fg-default placeholder:text-fg-faint focus:border-accent focus:outline-none"
              />
              <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded-sm border border-hairline px-1 font-mono text-2xs text-fg-subtle">
                {platform === 'mac' ? '⌘F' : 'Ctrl+F'}
              </kbd>
            </div>
          )}
          <nav aria-label={NAV_LABELS[area]} className="min-h-0 flex-1 overflow-auto px-2.5 pb-3">
            {nav}
          </nav>
        </aside>

        <main ref={mainRef} className="min-w-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-[720px] px-8 pt-9 pb-20">{children}</div>
        </main>
      </div>
    </ScrollToTop.Provider>
  );
}

/** One titled group of the menu. */
export function SettingsNavGroup({
  title,
  testId,
  children,
}: {
  readonly title: string;
  readonly testId?: string;
  readonly children: ReactNode;
}) {
  return (
    <div {...(testId === undefined ? {} : { 'data-testid': testId })} className="mt-3 first:mt-1">
      <h2 className="mb-1 px-2 text-xs font-medium text-fg-subtle">{title}</h2>
      <ul>{children}</ul>
    </div>
  );
}

/** One page in the menu; opening it brings the page back to its top. */
export function SettingsNavItem({
  label,
  icon: Icon,
  current,
  danger = false,
  modified = false,
  testId,
  onSelect,
}: {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly current: boolean;
  readonly danger?: boolean;
  readonly modified?: boolean;
  readonly testId: string;
  readonly onSelect: () => void;
}) {
  const scrollToTop = useContext(ScrollToTop);
  return (
    <li>
      <button
        type="button"
        data-testid={testId}
        aria-current={current ? 'page' : undefined}
        {...(modified ? { 'data-modified': 'true' } : {})}
        onClick={() => {
          onSelect();
          scrollToTop();
        }}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none ${
          current
            ? 'bg-surface-active text-fg-default'
            : `${danger ? 'text-status-danger' : 'text-fg-muted'} hover:bg-surface-hover hover:text-fg-default`
        }`}
      >
        <Icon size={14} aria-hidden="true" className="shrink-0 opacity-80" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {modified && (
          <span
            aria-hidden="true"
            data-testid="settings-nav-modified"
            title="Has changed settings"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-highlight"
          />
        )}
      </button>
    </li>
  );
}

/** A page's title and one-line subtitle, with room for its actions on the right. */
export function SettingsPageHeader({
  title,
  subtitle,
  actions,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly actions?: ReactNode;
}) {
  return (
    <>
      <div className="mb-1.5 flex items-end justify-between gap-4">
        <h1 className="text-[22px] leading-tight font-semibold text-fg-default">{title}</h1>
        {actions}
      </div>
      <p className="mb-6 text-sm text-fg-subtle">{subtitle}</p>
    </>
  );
}
