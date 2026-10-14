import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { CaseSensitive, ChevronDown, ChevronUp, Regex, WholeWord, X } from 'lucide-react';
import type { SearchAddon } from '@xterm/addon-search';
import type { Platform } from '../../lib/platform.js';
import { searchDecorationsFromCss } from './terminal-theme.js';

/** How many matches the addon highlights and counts; past this the count reads "1000+". */
export const FIND_HIGHLIGHT_LIMIT = 1000;

export interface FindOptions {
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly regex: boolean;
}

/** What the search addon last reported: the current match (-1 for none) and how many there are. */
export interface FindResults {
  readonly index: number;
  readonly count: number;
}

/** The scrollback search the bar drives; one terminal's search addon behind it. */
export interface TerminalFinder {
  /**
   * Moves to the next or previous match of `query`. `incremental` keeps the current match while it still
   * matches, which is what typing wants. Returns false for a regex that does not compile.
   */
  find(direction: 'next' | 'previous', query: string, options: FindOptions, incremental?: boolean): boolean;
  /** Takes the highlights away. */
  clear(): void;
}

/** ⌘F on a Mac, Ctrl+F elsewhere; on a Mac Ctrl+F stays the shell's forward-char. */
export function isFindChord(event: KeyboardEvent, platform: Platform): boolean {
  const mod = platform === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f';
}

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/** A finder over whatever search addon `addon` returns now, so a Reconnect's new terminal is searched. */
export function finderFor(addon: () => SearchAddon | undefined): TerminalFinder {
  return {
    find(direction, query, options, incremental = false) {
      const search = addon();
      if (search === undefined) return true;
      if (options.regex && !compiles(query)) {
        search.clearDecorations();
        return false;
      }
      const searchOptions = { ...options, decorations: searchDecorationsFromCss() };
      if (direction === 'next') search.findNext(query, { ...searchOptions, incremental });
      else search.findPrevious(query, searchOptions);
      return true;
    },
    clear() {
      addon()?.clearDecorations();
    },
  };
}

/** The count beside the query: "3 of 12", "No results", or why there is none. */
export function findCountLabel(query: string, invalid: boolean, results: FindResults | undefined): string {
  if (query === '') return '';
  if (invalid) return 'Invalid pattern';
  if (results === undefined) return '';
  if (results.count === 0) return 'No results';
  const count = `${String(results.count)}${results.count >= FIND_HIGHLIGHT_LIMIT ? '+' : ''}`;
  return results.index < 0 ? `${count} found` : `${String(results.index + 1)} of ${count}`;
}

export interface TerminalFindBarProps {
  readonly open: boolean;
  /** Changes each time the find chord is pressed, so a second press returns focus to the query. */
  readonly focusRequest: number;
  readonly finder: TerminalFinder;
  readonly results: FindResults | undefined;
  /** Escape or the close button; the owner hides the bar and focuses the terminal. */
  readonly onClose: () => void;
}

const NO_OPTIONS: FindOptions = { caseSensitive: false, wholeWord: false, regex: false };

/**
 * Find in a terminal's scrollback, over its top-right corner. Enter finds the next match, Shift+Enter the
 * previous; the query and options stay while the bar is closed, so reopening searches the same thing.
 */
export function TerminalFindBar({ open, focusRequest, finder, results, onClose }: TerminalFindBarProps) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<FindOptions>(NO_OPTIONS);
  const [invalid, setInvalid] = useState(false);
  const latest = useRef({ query, options });
  latest.current = { query, options };

  const run = (direction: 'next' | 'previous', nextQuery: string, nextOptions: FindOptions, incremental: boolean) => {
    if (nextQuery === '') {
      finder.clear();
      setInvalid(false);
      return;
    }
    setInvalid(!finder.find(direction, nextQuery, nextOptions, incremental));
  };

  // Opening searches what the bar last held; closing takes the highlights away.
  useEffect(() => {
    if (!open) {
      finder.clear();
      return;
    }
    const { query: current, options: currentOptions } = latest.current;
    if (current !== '') setInvalid(!finder.find('next', current, currentOptions, true));
  }, [open, finder]);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    input.current?.select();
  }, [open, focusRequest]);

  const toggle = (key: keyof FindOptions): void => {
    const next = { ...options, [key]: !options[key] };
    setOptions(next);
    run('next', query, next, true);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Nothing the bar handles goes on to the window's own shortcuts.
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'Enter' && event.target === input.current) {
      event.preventDefault();
      event.stopPropagation();
      run(event.shiftKey ? 'previous' : 'next', query, options, false);
    } else if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'f'
    ) {
      event.preventDefault();
      event.stopPropagation();
      input.current?.focus();
      input.current?.select();
    }
  };

  const label = findCountLabel(query, invalid, results);
  return (
    <div
      role="search"
      aria-label="Find in terminal"
      data-testid="terminal-find"
      hidden={!open}
      onKeyDown={onKeyDown}
      // Held between both edges of the pane and as wide as it needs: in a narrow pane the input gives way
      // rather than the bar running out past the pane's left edge.
      className="absolute top-2 right-4 left-2 z-10 ml-auto flex w-fit max-w-[calc(100%-1.5rem)] min-w-0 items-center gap-1 overflow-hidden rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
    >
      <input
        ref={input}
        type="text"
        aria-label="Find"
        aria-invalid={invalid}
        placeholder="Find"
        spellCheck={false}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          run('next', event.target.value, options, true);
        }}
        className={`w-48 min-w-16 shrink rounded border bg-surface-sunken px-2 py-0.5 text-sm text-fg-default outline-none ${
          invalid ? 'border-status-danger' : 'border-hairline focus:border-accent'
        }`}
      />
      <Toggle
        label="Match case"
        pressed={options.caseSensitive}
        onToggle={() => {
          toggle('caseSensitive');
        }}
      >
        <CaseSensitive size={14} aria-hidden="true" />
      </Toggle>
      <Toggle
        label="Match whole word"
        pressed={options.wholeWord}
        onToggle={() => {
          toggle('wholeWord');
        }}
      >
        <WholeWord size={14} aria-hidden="true" />
      </Toggle>
      <Toggle
        label="Use regular expression"
        pressed={options.regex}
        onToggle={() => {
          toggle('regex');
        }}
      >
        <Regex size={14} aria-hidden="true" />
      </Toggle>
      <span
        data-testid="terminal-find-count"
        aria-live="polite"
        className={`min-w-20 px-1 text-center text-xs whitespace-nowrap ${invalid ? 'text-status-danger' : 'text-fg-subtle'}`}
      >
        {label}
      </span>
      <IconButton
        label="Previous match"
        onClick={() => {
          run('previous', query, options, false);
        }}
      >
        <ChevronUp size={14} aria-hidden="true" />
      </IconButton>
      <IconButton
        label="Next match"
        onClick={() => {
          run('next', query, options, false);
        }}
      >
        <ChevronDown size={14} aria-hidden="true" />
      </IconButton>
      <IconButton label="Close find" onClick={onClose}>
        <X size={14} aria-hidden="true" />
      </IconButton>
    </div>
  );
}

const BUTTON = 'rounded p-1 text-fg-subtle hover:bg-surface-hover hover:text-fg-default';

function Toggle(props: {
  readonly label: string;
  readonly pressed: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
      onClick={props.onToggle}
      className={`${BUTTON} ${props.pressed ? 'bg-surface-selected text-fg-default' : ''}`}
    >
      {props.children}
    </button>
  );
}

function IconButton(props: { readonly label: string; readonly onClick: () => void; readonly children: ReactNode }) {
  return (
    <button type="button" aria-label={props.label} title={props.label} onClick={props.onClick} className={BUTTON}>
      {props.children}
    </button>
  );
}
