import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from '../../components/empty-state.js';
import type { SearchMatchWire, SearchScopesWire } from '../../../shared/wire-types.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';
import { revealSearchMatch } from './search-actions.js';

const DEBOUNCE_MS = 200;

const DEFAULT_SCOPES: SearchScopesWire = { requestBodies: true, headers: true, definitions: true };

const CONTROL =
  'h-row w-full min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default focus:outline-none focus:ring-1 focus:ring-accent';

/** The heading a match is grouped under: its request, or its definition document. */
function groupOf(match: SearchMatchWire): string {
  if (match.kind === 'document') {
    return `${match.interfaceName ?? 'Interface'} › ${match.location ?? ''}`;
  }
  const suffix = match.kind === 'request-header' ? ' › Headers' : '';
  return `${match.interfaceName ?? 'Interface'} › ${match.requestName ?? 'Request'}${suffix}`;
}

function groupMatches(matches: readonly SearchMatchWire[]): readonly (readonly [string, SearchMatchWire[]])[] {
  const groups = new Map<string, SearchMatchWire[]>();
  for (const match of matches) {
    const key = groupOf(match);
    groups.set(key, [...(groups.get(key) ?? []), match]);
  }
  return [...groups.entries()];
}

/**
 * The activity bar's Search view: find in project.
 *
 * The search itself runs in main (`search.query`) over request envelopes, request headers and
 * the cached definition documents, so a multi-megabyte WSDL is never copied into the renderer
 * to be scanned — only the matching lines come back. Clicking a result opens the request (or
 * the interface viewer's WSDL Content tab) at the matching line.
 */
export function SearchView() {
  const [query, setQuery] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [scopes, setScopes] = useState<SearchScopesWire>(DEFAULT_SCOPES);
  const [matches, setMatches] = useState<readonly SearchMatchWire[]>([]);
  const [truncated, setTruncated] = useState<'limit' | 'timeout' | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [searched, setSearched] = useState(false);
  const project = useProjectStore((state) => state.project);

  const toggleScope = useCallback((key: keyof SearchScopesWire) => {
    setScopes((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setMatches([]);
      setTruncated(undefined);
      setError(undefined);
      setSearched(false);
      return;
    }
    // Debounced: a project-wide scan per keystroke would search a dozen half-typed prefixes.
    const timer = setTimeout(() => {
      void ipc()
        .search.query({ query: trimmed, regex, caseSensitive, scopes })
        .then((result) => {
          setSearched(true);
          if (result.ok) {
            setMatches(result.value.matches);
            setTruncated(result.value.truncated ? (result.value.reason ?? 'limit') : undefined);
            setError(undefined);
          } else {
            setMatches([]);
            setTruncated(undefined);
            setError(result.error.message);
          }
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [query, regex, caseSensitive, scopes]);

  const groups = groupMatches(matches);

  return (
    <div data-testid="search-view" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 px-3 pb-2">
        <input
          type="search"
          aria-label="Search the project"
          data-testid="search-input"
          className={CONTROL}
          placeholder="Find in project"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        <div className="flex items-center gap-3 text-xs text-fg-subtle">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              data-testid="search-regex"
              checked={regex}
              onChange={() => {
                setRegex((value) => !value);
              }}
              className="h-3 w-3 accent-[var(--color-accent)]"
            />
            Regex
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              data-testid="search-case"
              checked={caseSensitive}
              onChange={() => {
                setCaseSensitive((value) => !value);
              }}
              className="h-3 w-3 accent-[var(--color-accent)]"
            />
            Match case
          </label>
        </div>
        <fieldset className="flex flex-wrap items-center gap-3 text-xs text-fg-subtle">
          <legend className="sr-only">Search in</legend>
          {(
            [
              ['requestBodies', 'Request bodies'],
              ['headers', 'Headers'],
              ['definitions', 'Definitions'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-1">
              <input
                type="checkbox"
                aria-label={label}
                data-testid={`search-scope-${key}`}
                checked={scopes[key]}
                onChange={() => {
                  toggleScope(key);
                }}
                className="h-3 w-3 accent-[var(--color-accent)]"
              />
              {label}
            </label>
          ))}
        </fieldset>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error !== undefined && (
          <p data-testid="search-error" className="px-3 py-2 text-sm text-status-danger">
            {error}
          </p>
        )}
        {error === undefined && project === null && (
          <EmptyState title="No project open" description="Open a project to search its requests and definitions." />
        )}
        {error === undefined && project !== null && searched && matches.length === 0 && (
          <p data-testid="search-empty" className="px-3 py-2 text-sm text-fg-subtle">
            No results.
          </p>
        )}
        {groups.map(([heading, group]) => (
          <section key={heading} data-testid="search-group">
            <h3 className="truncate px-3 py-1 text-xs tracking-wider text-fg-faint uppercase" title={heading}>
              {heading}
            </h3>
            <ul>
              {group.map((match) => (
                <li key={`${heading}:${String(match.start)}`}>
                  <button
                    type="button"
                    data-testid="search-result"
                    className="flex w-full items-baseline gap-2 px-3 py-0.5 text-left hover:bg-surface-raised"
                    onClick={() => {
                      revealSearchMatch(match);
                    }}
                  >
                    <span className="w-8 shrink-0 text-right font-mono text-xs text-fg-faint">{match.line}</span>
                    <span className="truncate font-mono text-xs text-fg-muted">{match.snippet}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {truncated !== undefined && (
          <p className="px-3 py-2 text-xs text-fg-faint">
            {truncated === 'timeout'
              ? 'Search stopped early — this pattern is too slow to finish. Try a simpler one.'
              : 'More results were found than are shown here.'}
          </p>
        )}
      </div>
    </div>
  );
}
