/**
 * The frame every view of the SSH area's fixed tab shares: one container width, a header (title, count,
 * search, primary action, one line on what the view is for), an empty state that says what to do first, and
 * the line a search that hides everything shows, with the way back.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Search, type LucideIcon } from 'lucide-react';
import { Button } from '../../components/button.js';
import { formatKeybinding } from '@shared/keybinding-format.js';
import { detectPlatform } from '../../lib/platform.js';

const INPUT_CLASS =
  'w-full rounded-md border border-hairline-strong bg-surface-base px-2 py-1 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent';

/** One view's column: the same width and spacing in all six. */
export function SshView({ children }: { readonly children: ReactNode }) {
  return <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">{children}</div>;
}

export interface SshViewSearch {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** The input's accessible name, "Filter hosts". */
  readonly label: string;
  readonly placeholder: string;
}

export interface SshViewHeaderProps {
  readonly title: string;
  /** How many the view holds, unfiltered; absent while it is still loading. */
  readonly count?: number;
  readonly search?: SshViewSearch;
  /** The primary action last, so it sits at the right edge. */
  readonly actions?: ReactNode;
  readonly description?: string;
}

/** The view's header. With a search, ⌘F (Ctrl+F elsewhere) goes to it and Escape clears it. */
export function SshViewHeader({ title, count, search, actions, description }: SshViewHeaderProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const platform = detectPlatform();
  const mac = platform === 'mac';
  const searching = search !== undefined;

  useEffect(() => {
    if (!searching) return undefined;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if ((mac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [mac, searching]);

  return (
    <header data-testid="ssh-view-header" className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-2 flex items-baseline gap-2 text-lg font-medium text-fg-default">
          {title}
          {count !== undefined && (
            <span data-testid="ssh-view-count" className="text-sm font-normal text-fg-subtle">
              {count}
            </span>
          )}
        </h2>
        {search !== undefined && (
          <label className="relative flex max-w-md min-w-48 flex-1 items-center">
            <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2 text-fg-subtle" />
            <input
              ref={searchRef}
              type="search"
              aria-label={search.label}
              placeholder={search.placeholder}
              className={`${INPUT_CLASS} pr-12 pl-7`}
              value={search.value}
              onChange={(e) => {
                search.onChange(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && search.value !== '') {
                  e.stopPropagation();
                  search.onChange('');
                }
              }}
            />
            <kbd className="pointer-events-none absolute right-2 rounded border border-hairline px-1 font-sans text-xs text-fg-subtle">
              {formatKeybinding('Mod+F', platform)}
            </kbd>
          </label>
        )}
        {actions !== undefined && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
      {description !== undefined && <p className="text-sm text-fg-subtle">{description}</p>}
    </header>
  );
}

export interface SshEmptyStateProps {
  readonly icon: LucideIcon;
  /** One sentence on the task the view is for. */
  readonly text: string;
  /** The primary action first. */
  readonly children: ReactNode;
  readonly testId?: string;
}

/** A view with nothing in it yet: what it is for, and the button that adds the first one. */
export function SshEmptyState({ icon: Icon, text, children, testId }: SshEmptyStateProps) {
  return (
    <div
      data-testid={testId ?? 'ssh-empty-state'}
      className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-hairline-strong px-6 py-12 text-center"
    >
      <span className="flex size-12 items-center justify-center rounded-xl bg-accent-muted text-fg-default">
        <Icon size={22} aria-hidden="true" />
      </span>
      <p className="max-w-sm text-sm text-fg-muted">{text}</p>
      <div className="flex gap-2">{children}</div>
    </div>
  );
}

/** A search (or filter) that leaves nothing: says so, and offers to clear it. */
export function SshNoMatches({ text, onClear }: { readonly text: string; readonly onClear: () => void }) {
  return (
    <div data-testid="ssh-no-matches" className="flex items-center gap-3 p-1 text-sm text-fg-subtle">
      <span>{text}</span>
      <Button onClick={onClear}>Clear search</Button>
    </div>
  );
}
