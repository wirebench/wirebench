/**
 * The response Query view: an XPath 3.1 / XQuery 3.1 / JSONPath scratchpad over the response,
 * ahead of any assertion and over the full response. Evaluation runs in main
 * (`xpath.evaluate`) so the renderer never bundles `fontoxpath` or `jsonpath-plus`.
 *
 * JSONPath is offered only for a JSON response, and the namespace table only for an XML one — each
 * is meaningless for the other document kind.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { EmptyState } from '../../../components/empty-state.js';
import { ipc } from '../../../state/ipc-client.js';
import type { TextRange } from './xml-model.js';

/** The languages the view can offer. `jsonpath` appears only for a JSON response. */
export type QueryLanguageWire = 'xpath' | 'xquery' | 'jsonpath';

/** The label on each language's radio button. */
const LANGUAGE_LABELS: Readonly<Record<QueryLanguageWire, string>> = {
  xpath: 'XPath 3.1',
  xquery: 'XQuery 3.1',
  jsonpath: 'JSONPath',
};

/** One node or value result item, as returned over the wire by `xpath.evaluate`. */
interface ResultItem {
  readonly text: string;
  readonly nodeKind?: 'element' | 'attribute' | 'text' | 'document' | 'comment' | 'pi' | undefined;
  readonly range?: TextRange | undefined;
  readonly path?: string | undefined;
  readonly type?: string | undefined;
}

/** The `xpath.evaluate` result shape this view renders, as returned over the wire. */
export type QueryResultWire =
  | { readonly kind: 'nodes'; readonly items: readonly ResultItem[]; readonly truncated: boolean }
  | { readonly kind: 'values'; readonly items: readonly ResultItem[]; readonly truncated: boolean }
  | { readonly kind: 'empty' }
  | {
      readonly kind: 'error';
      readonly message: string;
      readonly code?: string | undefined;
      readonly position?: { readonly line: number; readonly column: number } | undefined;
    };

/** The `xpath.*` channel pair this view needs; injectable for tests. */
export interface QuerySource {
  evaluate(request: {
    xml: string;
    expression: string;
    language: QueryLanguageWire;
    namespaces?: Record<string, string>;
  }): Promise<{ ok: true; value: QueryResultWire } | { ok: false; error?: { message: string } }>;
  namespaces(request: {
    xml: string;
  }): Promise<
    { ok: true; value: { namespaces: Record<string, string>; suggestions: Record<string, string> } } | { ok: false }
  >;
}

/** How many past expressions the history strip keeps, newest first. */
const HISTORY_LIMIT = 10;

/**
 * Quick examples shown in the empty state, before the user has run anything — per document kind,
 * because an XPath over an envelope is no help at all in front of a JSON body.
 */
const EXAMPLES: Readonly<Record<'xml' | 'json', readonly string[]>> = {
  xml: ['//tem:AddResult/text()', 'count(//*)', 'for $x in //* return name($x)'],
  json: ['$..id', '$.items[?(@.status=="open")].id', '?items?*?id', 'count(?items?*)'],
};

/** In-memory expression history per request draft — survives this view remounting (e.g. a tab
 * switch) but not an app restart, matching the brief's "in-memory" history. */
const historyByRequest = new Map<string, string[]>();

function recordHistory(requestId: string, expression: string): string[] {
  const existing = historyByRequest.get(requestId) ?? [];
  const next = [expression, ...existing.filter((entry) => entry !== expression)].slice(0, HISTORY_LIMIT);
  historyByRequest.set(requestId, next);
  return next;
}

/** One prefix/URI row in the namespace table. */
interface NamespaceRow {
  readonly id: string;
  readonly prefix: string;
  readonly uri: string;
}

let nextRowId = 0;

/** Builds the namespace table's initial rows from `xpath.namespaces`'s two maps: `namespaces`
 * (every prefix, or `''` for the default namespace, already bound in the document) and
 * `suggestions` (a URI to conventional-prefix map for every namespace that has no *real* prefix
 * bound to it — in practice, always at least the default namespace when the document has one).
 * A default-namespace row's `prefix` is pre-filled with its suggestion (still editable) instead
 * of being seeded empty, since an empty prefix can never be sent to `xpath.evaluate` — leaving
 * it blank is how a namespace binding silently went unusable before this seeding existed. */
function toRows(
  namespaces: Readonly<Record<string, string>>,
  suggestions: Readonly<Record<string, string>>,
): NamespaceRow[] {
  return Object.entries(namespaces).map(([prefix, uri]) => ({
    id: String((nextRowId += 1)),
    prefix: prefix === '' ? (suggestions[uri] ?? prefix) : prefix,
    uri,
  }));
}

/**
 * The example expression the box shows, per language and document kind.
 *
 * A placeholder is the only documentation most users will read for this view, so each one is a
 * working expression for the shape of document actually in front of them.
 */
export function placeholderFor(language: QueryLanguageWire, documentKind: 'xml' | 'json'): string {
  if (language === 'jsonpath') {
    return '$.items[?(@.status=="open")].id';
  }
  if (documentKind === 'json') {
    return language === 'xpath' ? '?items?*[?status = "open"]?id' : 'for $i in ?items?* return $i?id';
  }
  return language === 'xpath' ? '//tem:AddResult/text()' : 'for $x in //* return name($x)';
}

export interface QueryViewProps {
  /** Keys the in-memory expression history and the seeded namespace table to this request draft. */
  readonly requestId: string;
  /** The response document to query: an envelope, or a JSON body. */
  readonly xml: string;
  /**
   * What `xml` is. Defaults to `xml`.
   *
   * JSON gets the same two languages — XPath 3.1 has maps, arrays and `?` lookup — and loses only the
   * namespace table, because JSON has no names to qualify.
   */
  readonly documentKind?: 'xml' | 'json';
  /** Fired when "Reveal" is pressed on a node result: the XML view should select this range. */
  readonly onReveal?: (range: TextRange) => void;
  /** `xpath.*` by default; injectable for tests. */
  readonly source?: QuerySource;
}

/** The Query view: expression textarea, language toggle, namespace table, and results. */
export function QueryView({ requestId, xml, documentKind = 'xml', onReveal, source }: QueryViewProps) {
  const api = useMemo<QuerySource>(() => source ?? ipc().xpath, [source]);
  const isJson = documentKind === 'json';

  const languages: readonly QueryLanguageWire[] = isJson ? ['xpath', 'xquery', 'jsonpath'] : ['xpath', 'xquery'];
  const [language, setLanguage] = useState<QueryLanguageWire>('xpath');
  // A view that started on a JSON response and was handed an XML one (a resend against a different
  // endpoint, say) must not keep a language the new document cannot be queried with.
  const effectiveLanguage: QueryLanguageWire = !isJson && language === 'jsonpath' ? 'xpath' : language;
  const [expression, setExpression] = useState('');
  const [rows, setRows] = useState<NamespaceRow[]>([]);
  const [result, setResult] = useState<QueryResultWire | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>(() => historyByRequest.get(requestId) ?? []);

  // Re-seeds the namespace table whenever a new response arrives (including the first one).
  // After that, the user's own edits to the table are theirs — this effect only reruns when
  // `xml` itself changes, not on every render.
  useEffect(() => {
    if (isJson) {
      // Nothing to seed: a JSON document binds no namespaces, so the table is not shown at all.
      return;
    }
    let cancelled = false;
    void api.namespaces({ xml }).then((res) => {
      if (!cancelled && res.ok) {
        setRows(toRows(res.value.namespaces, res.value.suggestions));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api, xml, isJson]);

  const run = useCallback(
    (expr: string) => {
      const trimmed = expr.trim();
      if (trimmed === '') {
        return;
      }
      setRunning(true);
      const namespaces = Object.fromEntries(
        rows.filter((row) => row.prefix !== '' && row.uri !== '').map((row) => [row.prefix, row.uri]),
      );
      void api
        .evaluate({
          xml,
          expression: trimmed,
          language: effectiveLanguage,
          namespaces,
          ...(isJson ? { kind: 'json' as const } : {}),
        })
        .then((res) => {
          setResult(res.ok ? res.value : { kind: 'error', message: res.error?.message ?? 'Query failed' });
          setHistory(recordHistory(requestId, trimmed));
        })
        .finally(() => setRunning(false));
    },
    [api, xml, effectiveLanguage, rows, requestId, isJson],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      run(expression);
    }
  };

  const setRow = (id: string, patch: Partial<Omit<NamespaceRow, 'id'>>) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const removeRow = (id: string) => {
    setRows((current) => current.filter((row) => row.id !== id));
  };

  const addRow = () => {
    setRows((current) => [...current, { id: String((nextRowId += 1)), prefix: '', uri: '' }]);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-hairline p-2">
        <div className="mb-2 flex items-center gap-2">
          <div role="radiogroup" aria-label="Query language" className="flex gap-1">
            {languages.map((id) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={effectiveLanguage === id}
                onClick={() => setLanguage(id)}
                className={`rounded-sm px-2 py-0.5 text-xs ${
                  effectiveLanguage === id
                    ? 'bg-surface-active text-fg-default'
                    : 'text-fg-subtle hover:bg-surface-hover'
                }`}
              >
                {LANGUAGE_LABELS[id]}
              </button>
            ))}
          </div>
          <button
            type="button"
            data-testid="query-run"
            disabled={running}
            onClick={() => run(expression)}
            className="ml-auto rounded-sm bg-accent px-3 py-0.5 text-xs text-fg-on-accent disabled:opacity-50"
          >
            Run ⌘⏎
          </button>
        </div>
        <textarea
          aria-label="Query expression"
          value={expression}
          onChange={(event) => setExpression(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          spellCheck={false}
          placeholder={placeholderFor(effectiveLanguage, documentKind)}
          className="w-full resize-none rounded-md border border-hairline-strong bg-surface-raised p-2 font-mono text-sm text-fg-default"
        />

        {!isJson && (
          <>
            <table className="mt-2 w-full text-xs">
              <caption className="sr-only">Namespace bindings</caption>
              <thead>
                <tr className="text-left text-fg-muted">
                  <th scope="col" className="w-24 font-normal">
                    Prefix
                  </th>
                  <th scope="col" className="font-normal">
                    Namespace URI
                  </th>
                  <th scope="col" className="w-8" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="pr-1 py-0.5">
                      <input
                        aria-label="Namespace prefix"
                        value={row.prefix}
                        onChange={(event) => setRow(row.id, { prefix: event.target.value })}
                        className="w-full rounded-sm border border-hairline-strong bg-surface-raised px-1 font-mono"
                      />
                    </td>
                    <td className="pr-1 py-0.5">
                      <input
                        aria-label="Namespace URI"
                        value={row.uri}
                        onChange={(event) => setRow(row.id, { uri: event.target.value })}
                        className="w-full rounded-sm border border-hairline-strong bg-surface-raised px-1 font-mono"
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        aria-label="Remove namespace binding"
                        onClick={() => removeRow(row.id)}
                        className="text-fg-subtle hover:text-fg-default"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" onClick={addRow} className="mt-1 text-xs text-accent hover:underline">
              + Add namespace
            </button>
          </>
        )}
        {!isJson && rows.some((row) => row.prefix === '' && row.uri !== '') && (
          <p className="mt-1 text-xs text-status-warning" role="status">
            Rows with no prefix can&apos;t be referenced in an expression — add one to query this namespace.
          </p>
        )}
        {isJson && effectiveLanguage !== 'jsonpath' && (
          <p className="mt-1 text-xs text-fg-subtle">
            The response is the context item: <code>?field</code> reads a key, <code>?*</code> every member of an array.
          </p>
        )}
        {isJson && effectiveLanguage === 'jsonpath' && (
          <p className="mt-1 text-xs text-fg-subtle">
            The response is <code>$</code>: <code>$.field</code> reads a key, <code>$..field</code> at any depth,
            <code> $[?(@.k==&quot;v&quot;)]</code> filters. Each result shows the path it was found at.
          </p>
        )}

        {history.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {history.map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => {
                  setExpression(entry);
                  run(entry);
                }}
                className="max-w-full truncate rounded-sm bg-surface-hover px-2 py-0.5 font-mono text-xs text-fg-muted hover:text-fg-default"
                title={entry}
              >
                {entry}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto" data-testid="query-results">
        {result === undefined ? (
          <EmptyState title="Query the response" description="Try one of these, or write your own.">
            <div className="flex flex-col gap-1">
              {EXAMPLES[documentKind].map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => {
                    setExpression(example);
                    run(example);
                  }}
                  className="rounded-sm bg-surface-hover px-2 py-1 font-mono text-xs text-fg-muted hover:text-fg-default"
                >
                  {example}
                </button>
              ))}
            </div>
          </EmptyState>
        ) : result.kind === 'empty' ? (
          <p className="p-3 text-sm text-fg-muted">No results.</p>
        ) : result.kind === 'error' ? (
          <div className="p-3 text-sm text-status-danger" role="alert">
            <p>{result.message}</p>
            {result.position !== undefined && (
              <p className="mt-1 text-xs text-fg-muted">
                Line {result.position.line}, column {result.position.column}
              </p>
            )}
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-hairline">
            {result.items.map((item, index) => (
              <li key={index} className="flex items-start justify-between gap-2 p-2">
                <div className="min-w-0 flex-1">
                  {item.path !== undefined && <div className="text-xs text-fg-muted">{item.path}</div>}
                  {item.type !== undefined && <div className="text-xs text-fg-muted">{item.type}</div>}
                  <pre className="mt-0.5 overflow-auto font-mono text-sm break-words whitespace-pre-wrap text-fg-default">
                    {item.text}
                  </pre>
                </div>
                {item.range !== undefined && onReveal !== undefined && (
                  <button
                    type="button"
                    onClick={() => onReveal(item.range as TextRange)}
                    className="shrink-0 rounded-sm px-2 py-0.5 text-xs text-accent hover:bg-surface-hover"
                  >
                    Reveal
                  </button>
                )}
              </li>
            ))}
            {result.truncated && (
              <li className="p-2 text-xs text-status-warning">
                Only the first {result.items.length} results are shown.
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
