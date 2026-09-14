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
import { KvTable } from '../../components/kv-table.js';
import type { KeyValueWire, RestRequestPatchWire } from '../../../shared/wire-types.js';
import { urlWithQuery } from '../../state/rest-url.js';

export interface ParamsTabProps {
  readonly url: string;
  readonly pathParams: readonly KeyValueWire[];
  readonly query: readonly KeyValueWire[];
  readonly onChange: (patch: RestRequestPatchWire) => void;
}

/** The Params tab: the path table above the query table. */
export function ParamsTab({ url, pathParams, query, onChange }: ParamsTabProps) {
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
          emptyMessage="No {placeholders} in this URL."
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
    </div>
  );
}
