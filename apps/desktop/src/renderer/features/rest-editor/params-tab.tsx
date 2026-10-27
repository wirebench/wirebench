/**
 * Path parameters and query parameters.
 *
 * The query table and the URL are two views of one thing, so they are kept in step in both
 * directions: editing the table rewrites the URL's query string, and editing the URL re-reads the
 * table. Both directions go through the engine's own `splitQuery`/`joinQuery`, so neither view can
 * disagree with what the send path builds.
 *
 * A path parameter's *name* is not editable: it comes from a `{param}` in the URL. Removing the
 * placeholder removes the row, because there would be nowhere to send the value.
 */
import { useId } from 'react';
import { KvTable } from '../../components/kv-table.js';
import type { RestRequestPatchWire } from '@shared/kinds/rest/wire.js';
import type { KeyValueWire } from '@shared/wire-base.js';
import { urlWithQuery } from '../../state/rest-url.js';
import { useVariableAssist } from '../../components/variable-field.js';
import { urlVariableRows } from './url-variables.js';

export interface ParamsTabProps {
  readonly url: string;
  readonly pathParams: readonly KeyValueWire[];
  readonly query: readonly KeyValueWire[];
  readonly onChange: (patch: RestRequestPatchWire) => void;
}

/** The Params tab: the path table above the query table, and the URL's `${…}` variables after them. */
export function ParamsTab({ url, pathParams, query, onChange }: ParamsTabProps) {
  const variables = useVariableAssist()?.variables;
  const urlVariables = urlVariableRows(url, variables);
  const headingId = useId();
  return (
    <div data-testid="rest-params" className="flex flex-col gap-4 overflow-auto p-3">
      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-medium tracking-wider text-fg-subtle uppercase">Path parameters</h3>
        <KvTable
          label="Path parameters"
          testidPrefix="rest-path"
          rows={pathParams}
          lockNames
          allowDuplicates={false}
          // A `${host}` is a variable, not a path parameter: say which syntax this table means (G09).
          emptyMessage="No path parameters like {id} in this URL."
          onChange={(rows) => {
            onChange({ pathParams: [...rows] });
          }}
        />
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-medium tracking-wider text-fg-subtle uppercase">Query parameters</h3>
        <KvTable
          label="Query parameters"
          testidPrefix="rest-query"
          rows={query}
          columns={['enabled', 'name', 'value', 'description']}
          emptyMessage="No query parameters."
          onChange={(rows) => {
            // The URL follows the table, so the field the user reads and the request that goes out
            // never disagree. Only enabled rows reach the URL — see `urlWithQuery`.
            onChange({ query: [...rows], url: urlWithQuery(url, rows) });
          }}
        />
      </section>
      {urlVariables.length > 0 && (
        <section className="flex flex-col gap-1" aria-labelledby={headingId}>
          <h3 id={headingId} className="text-xs font-medium tracking-wider text-fg-subtle uppercase">
            Variables in this URL
          </h3>
          <dl
            data-testid="rest-url-variables"
            className="grid grid-cols-[max-content_max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm"
          >
            {urlVariables.map((row) => (
              <div key={row.raw} data-testid="rest-url-variable" className="contents">
                <dt className="font-mono text-accent">{row.raw}</dt>
                <dd className={row.unresolved ? 'text-status-danger' : 'text-fg-subtle'}>{row.source}</dd>
                <dd className="truncate font-mono text-fg-default" title={row.value}>
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}
