/**
 * The counts on the REST tabs that hold rows: Params and Headers on the request, Headers on the
 * response. Each reads like the Assertions count beside it — a number, and nothing when there is
 * nothing — so a glance at the strip says where the request's rows are.
 */
import type { KeyValueWire } from '../../../shared/wire-base.js';

/** The rows a table sends: switched on and named. The empty add row is never one of them. */
export function rowsBadge(rows: readonly Pick<KeyValueWire, 'name' | 'enabled'>[]): string | undefined {
  const count = rows.filter((row) => row.enabled && row.name !== '').length;
  return count === 0 ? undefined : String(count);
}

/** The headers a response came back with, counted as the Headers tab lists them: a repeat counts twice. */
export function responseHeadersBadge(http: {
  readonly headers: Readonly<Record<string, string>>;
  readonly rawHeaders?: readonly (readonly [string, string])[] | undefined;
}): string | undefined {
  const count = http.rawHeaders?.length ?? Object.keys(http.headers).length;
  return count === 0 ? undefined : String(count);
}
