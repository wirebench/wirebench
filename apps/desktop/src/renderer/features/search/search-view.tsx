import { useCallback, useEffect, useRef, useState } from 'react';
import { EmptyState } from '../../components/empty-state.js';
import type { SearchMatchWire, SearchScopesWire } from '../../../shared/wire-base.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';
import { rendererKindOf } from '../../kinds/index.js';
import { MethodBadge } from '../rest-api/method-badge.js';
import { revealSearchMatch } from './search-actions.js';

/** A match group's kind badge; none for SOAP. */
function searchBadge(protocol: string | undefined): string | undefined {
  return rendererKindOf(protocol)?.search.badge;
}

const DEBOUNCE_MS = 200;

const DEFAULT_SCOPES: SearchScopesWire = { requestBodies: true, headers: true, definitions: true };

const CONTROL =
  'h-row w-full min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default focus:outline-none focus:ring-1 focus:ring-accent';

/** What heads a group of matches: the method and name on one line, the path faint under it. */
export interface SearchGroupHeading {
  /** Tells groups apart: two requests can share a name and a path. */
  readonly key: string;
  /** A REST request's method; absent for the other kinds and for a definition document. */
  readonly method?: string;
  /** The request's name, or the definition document's location. */
  readonly name: string;
  /** `project › interface`, and `› Headers` for a header match. */
  readonly path: string;
}

/**
 * The heading a match is grouped under. The name leads, with the method before it, so a narrow sidebar
 * still shows which request matched: a `project › interface › request` breadcrumb cut every group to the
 * same "PAYMENTS › SWAGGER P…". Search spans every open project, so the path starts with the project when
 * the match carries one.
 */
export function searchGroupHeading(match: SearchMatchWire): SearchGroupHeading {
  const document = match.kind === 'document';
  const path = [
    ...(match.projectName === undefined ? [] : [match.projectName]),
    match.interfaceName ?? 'Interface',
    ...(match.kind === 'request-header' ? ['Headers'] : []),
  ].join(' › ');
  const name = document ? (match.location ?? '') : (match.requestName ?? 'Request');
  const key = [
    match.projectId ?? match.projectName ?? '',
    match.protocol ?? 'soap',
    match.kind,
    document ? `${match.interfaceId ?? ''} ${match.location ?? ''}` : (match.requestId ?? name),
  ].join('|');
  return { key, ...(document || match.method === undefined ? {} : { method: match.method }), name, path };
}

function groupMatches(
  matches: readonly SearchMatchWire[],
): readonly (readonly [SearchGroupHeading, SearchMatchWire[]])[] {
  const groups = new Map<string, readonly [SearchGroupHeading, SearchMatchWire[]]>();
  for (const match of matches) {
    const heading = searchGroupHeading(match);
    const group = groups.get(heading.key);
    if (group === undefined) groups.set(heading.key, [heading, [match]]);
    else group[1].push(match);
  }
  return [...groups.values()];
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
  const hasProject = useProjectStore((state) => Object.keys(state.projects).length > 0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Opening the view is asking to search: the caret goes straight to the input.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
          ref={inputRef}
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
        {error === undefined && !hasProject && (
          <EmptyState title="No project open" description="Add a project to search its requests and definitions." />
        )}
        {error === undefined && hasProject && searched && matches.length === 0 && (
          <p data-testid="search-empty" className="px-3 py-2 text-sm text-fg-subtle">
            No results.
          </p>
        )}
        {groups.map(([heading, group]) => (
          <section key={heading.key} data-testid="search-group">
            <div className="px-3 pt-1.5 pb-0.5" title={`${heading.name}\n${heading.path}`}>
              <h3 className="flex min-w-0 items-center gap-1.5 text-xs">
                {/* Which protocol the group's request belongs to: two requests may share a name, and
                    a click opens a different editor for each. */}
                {searchBadge(group[0]?.protocol) !== undefined && (
                  <span
                    data-testid="search-result-badge"
                    className="shrink-0 rounded-full bg-surface-base px-1.5 text-fg-faint"
                  >
                    {searchBadge(group[0]?.protocol)}
                  </span>
                )}
                {heading.method !== undefined && <MethodBadge method={heading.method} className="w-auto shrink-0" />}
                <span data-testid="search-group-name" className="truncate font-medium text-fg-default">
                  {heading.name}
                </span>
              </h3>
              <p data-testid="search-group-path" className="truncate text-xs text-fg-faint">
                {heading.path}
              </p>
            </div>
            <ul>
              {group.map((match) => (
                <li key={`${heading.key}:${String(match.start)}`}>
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
