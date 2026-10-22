/**
 * The `${…}` variables a request's URL uses, for the Params tab (G09): each written once, with where
 * it resolves and to what, in the words the URL field's hover uses.
 *
 * Path parameters (`{id}`) and variables (`${host}`) look alike in a URL but are different things: a
 * path parameter is filled from the table above it, a variable from the scopes the request reads.
 * Listing the variables beside the path table keeps the two apart.
 */
import { propertyReferences } from '@wirebench/engine/rest';
import { classifyReference, hoverContent, type RequestVariables } from '../../editor/variable-assist.js';

export interface UrlVariableRow {
  /** The reference as written, `${host}`. */
  readonly raw: string;
  /** Where it resolves: a scope's name, Secret, Dynamic, Unresolved, or that only a send can tell. */
  readonly source: string;
  /** Its value as the hover shows it (masked for a secret), or why it has none. */
  readonly value: string;
  readonly unresolved: boolean;
}

/** What a reference says while only a send can resolve it (a list not yet answered, a nested one). */
const AT_SEND = 'Resolved when sent';

/** The distinct references in `url`, in order, each with where it resolves. */
export function urlVariableRows(url: string, variables: RequestVariables | undefined): readonly UrlVariableRow[] {
  const seen = new Set<string>();
  const rows: UrlVariableRow[] = [];
  for (const reference of propertyReferences(url)) {
    const raw = url.slice(reference.start, reference.end);
    if (seen.has(raw)) continue;
    seen.add(raw);
    const hover = hoverContent(classifyReference(reference, variables), raw);
    rows.push(
      hover === undefined
        ? { raw, source: AT_SEND, value: '', unresolved: false }
        : { raw, source: hover.scope, value: hover.value, unresolved: hover.unresolved === true },
    );
  }
  return rows;
}
